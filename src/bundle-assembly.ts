import {
  type ConnectionRow,
  type DeploymentRow,
  type LogSourceRow,
  decryptConnectionCredentials,
  decryptDestinationConfig,
  ensureHeartbeatToken,
  getConnection,
  getConnectionsByIds,
  getDeployment,
  getDestination,
  getSourcesByIdsForUser,
  listMonitorsForConnection,
  listSinksForMonitor,
  listSources,
  parseDeploymentSelection,
} from "./db";
import type { Env } from "./env";
import {
  type GeneratedBundle,
  type GenerateInput,
  generateBundle,
  toCoreInput,
} from "./generator";
import { getProvider } from "./providers";

export interface AssembledBundle {
  deployment: DeploymentRow;
  bundle: GeneratedBundle;
  heartbeatToken: string;
  input: import("@logtura/core").GenerateInput;
  credentialIsFresh: boolean;
  credentialStaleReason?: string;
  credentialExpiresAt?: number | null;
}

/**
 * Build the generated bundle for a deployment. Shared between the
 * /deployments/:id/bundle endpoint (which renders the self-deploy UI)
 * and the fly_deploy job (which ships the same artifacts to Fly's
 * Machines API). Centralising avoids drift between "what the user sees
 * in the UI" and "what we actually deploy."
 */
export async function assembleDeploymentBundle(
  env: Env,
  userId: string,
  deploymentId: string,
): Promise<AssembledBundle> {
  const deployment = await getDeployment(env.DB, userId, deploymentId);
  if (!deployment) throw new Error("deployment not found");

  const selection = parseDeploymentSelection(deployment);

  // CONNECTIONS ARE DERIVED FROM SELECTED SOURCES. A deployment is
  // "this set of source IDs to forward"; whatever connections own
  // those sources are the ones we need creds for. No join table —
  // the source → connection FK is the source of truth.
  //
  // sourceIds === null is treated as "all sources from the
  // deployment's primary connection_id" for back-compat with rows
  // created before the explicit-selection model. New rows write
  // explicit arrays; this branch keeps existing deployments working.
  let selectedSources: LogSourceRow[];
  if (selection.sourceIds === null) {
    if (!deployment.connection_id) {
      selectedSources = [];
    } else {
      selectedSources = await listSources(env.DB, deployment.connection_id);
    }
  } else {
    selectedSources = await getSourcesByIdsForUser(
      env.DB,
      userId,
      selection.sourceIds,
    );
  }

  // Group sources by their owning connection. This implicitly
  // computes the set of connections to load + decrypt.
  const sourcesByConnId = new Map<string, LogSourceRow[]>();
  for (const s of selectedSources) {
    const list = sourcesByConnId.get(s.connection_id) ?? [];
    list.push(s);
    sourcesByConnId.set(s.connection_id, list);
  }
  let connectionIds = Array.from(sourcesByConnId.keys());
  // Empty-selection deployment (heartbeat-only) still needs at
  // least one connection's creds for the bundle's "Connection"
  // header. Fall back to the deployment's primary.
  if (connectionIds.length === 0 && deployment.connection_id) {
    connectionIds = [deployment.connection_id];
  }
  if (connectionIds.length === 0) {
    throw new Error("connection not found");
  }
  const connections = await getConnectionsByIds(env.DB, userId, connectionIds);

  // Same-provider collision is enforced HERE rather than at the
  // route: two CF connections would both want CLOUDFLARE_API_TOKEN
  // and we can't disambiguate. The UI prevents it at picker time,
  // but bundle assembly is the bottleneck that has to fail loudly
  // if it ever happens (stale UI, API call, etc.).
  const seenProviders = new Map<string, string>();
  for (const c of connections) {
    const prior = seenProviders.get(c.provider);
    if (prior) {
      throw new Error(
        `deployment has sources from two ${c.provider} connections (${prior} + ${c.id}); only one connection per provider is supported`,
      );
    }
    seenProviders.set(c.provider, c.id);
  }

  // Per-connection: selected sources, decrypted creds, freshness.
  // We treat freshness as a per-connection signal but roll it up to
  // a single boolean for the AssembledBundle return shape so the
  // existing API surface (`credentialIsFresh`) stays stable —
  // "any connection is stale" trips the UI's stale banner.
  const perConn: Array<{
    connection: ConnectionRow;
    selectedSources: LogSourceRow[];
    credentials?: Record<string, unknown>;
    fresh: boolean;
    staleReason?: string;
    expiresAt?: number | null;
  }> = [];
  for (const c of connections) {
    const sources = sourcesByConnId.get(c.id) ?? [];
    const credentials =
      await decryptConnectionCredentials<Record<string, unknown>>(env, c);
    // For OAuth-derived Supabase credentials, inject a tail-token
    // (signed JWT scoped to this connection) + the URL of the SaaS
    // refresh endpoint. The driver consumes these via credentialPath
    // env-var bindings; values never persist to D1, they're minted
    // fresh on every bundle assembly. The actual Supabase OAuth
    // secrets (refresh_token, expiresAt) stay in D1 — only the
    // sidecar's bootstrap envelope lands in the deployment env.
    if (
      c.provider === "supabase-edge-logs" &&
      typeof credentials.refreshToken === "string"
    ) {
      const { mintTailToken } = await import("./providers/tail-token");
      const tailToken = await mintTailToken(
        { connectionId: c.id, userId: c.user_id },
        env.SESSION_SECRET,
      );
      credentials.tailToken = tailToken;
      credentials.tailTokenUrl = `${env.APP_URL}/api/tail/supabase/token`;
    }
    if (
      c.provider === "railway-logs" &&
      typeof credentials.refreshToken === "string"
    ) {
      const { mintTailToken } = await import("./providers/tail-token");
      const tailToken = await mintTailToken(
        { connectionId: c.id, userId: c.user_id },
        env.SESSION_SECRET,
      );
      credentials.apiToken = `${env.APP_URL}/api/tail/railway/token#${tailToken}`;
    }
    let fresh = true;
    let staleReason: string | undefined;
    let expiresAt: number | null | undefined;
    const provider = getProvider(c.provider);
    if (provider?.checkCredentialFreshness) {
      try {
        const r = await provider.checkCredentialFreshness(credentials);
        fresh = r.fresh;
        staleReason = r.reason;
        expiresAt = r.expiresAt ?? null;
      } catch (err) {
        console.warn("credential freshness check threw", err);
        fresh = false;
        staleReason = "freshness check failed";
      }
    }
    perConn.push({
      connection: c,
      selectedSources: sources,
      credentials,
      fresh,
      staleReason,
      expiresAt: expiresAt ?? undefined,
    });
  }

  // Monitors are user-scoped. A monitor's `connection_id` is
  // nullable — null = "applies to all connections". When non-null
  // it only applies to events from that specific connection.
  // Filter to monitors that match SOME derived connection.
  const monitorsSeen = new Set<string>();
  const applicableMonitors = [];
  for (const c of connections) {
    const candidates = await listMonitorsForConnection(env.DB, userId, c.id);
    for (const m of candidates) {
      if (monitorsSeen.has(m.id)) continue;
      monitorsSeen.add(m.id);
      if (selection.monitorIds === null || selection.monitorIds.includes(m.id)) {
        applicableMonitors.push(m);
      }
    }
  }

  const generatorMonitors = [];
  for (const monitor of applicableMonitors) {
    const sinks = await listSinksForMonitor(env.DB, monitor.id);
    const generatorSinks = [];
    for (const sink of sinks) {
      const destination = await getDestination(env.DB, userId, sink.destination_id);
      if (!destination) continue;
      const destinationConfig = await decryptDestinationConfig(env, destination);
      generatorSinks.push({ sink, destination, destinationConfig });
    }
    generatorMonitors.push({ monitor, sinks: generatorSinks });
  }

  // Roll per-connection freshness up to a single bundle-level
  // signal. The UI explains "X of Y connections have stale
  // credentials" via the reason; the boolean gates whether we
  // inline values at all.
  const staleConns = perConn.filter((c) => !c.fresh);
  const credentialIsFresh = staleConns.length === 0;
  const credentialStaleReason = staleConns.length
    ? staleConns
        .map((c) => `${c.connection.display_name}: ${c.staleReason ?? "stale"}`)
        .join("; ")
    : undefined;
  const credentialExpiresAt = perConn
    .map((c) => c.expiresAt ?? null)
    .filter((v): v is number => v !== null)
    .reduce<number | null>((m, v) => (m === null || v < m ? v : m), null);

  // Resolve metrics target. "none"/null = no metrics sink;
  // "logtura" = the http-POST-to-us sink; anything else is treated
  // as a destination id and we look it up + decrypt its config.
  let metricsInput: GenerateInput["metrics"];
  const metricsTarget = deployment.metrics_target;
  if (!metricsTarget || metricsTarget === "none") {
    metricsInput = { kind: "none" };
  } else if (metricsTarget === "logtura") {
    metricsInput = {
      kind: "logtura",
      deploymentId: deployment.id,
      appUrl: env.APP_URL,
    };
  } else {
    const mDest = await getDestination(env.DB, userId, metricsTarget);
    if (mDest) {
      const mConfig = await decryptDestinationConfig(env, mDest);
      metricsInput = {
        kind: "destination",
        destination: mDest,
        destinationConfig: mConfig,
      };
    } else {
      metricsInput = { kind: "none" };
    }
  }

  const generatorInput: GenerateInput = {
    connections: perConn.map((c) => ({
      connection: c.connection,
      selectedSources: c.selectedSources,
      credentials: c.fresh ? c.credentials : undefined,
    })),
    monitors: generatorMonitors,
    heartbeat: {
      kind:
        (deployment.heartbeat_target ?? "logtura") === "logtura"
          ? "logtura"
          : "none",
      deploymentId: deployment.id,
      appUrl: env.APP_URL,
    },
    metrics: metricsInput,
  };
  const bundle = generateBundle(generatorInput);

  const heartbeatToken = await ensureHeartbeatToken(env.DB, deployment);
  for (const v of bundle.envVars) {
    if (v.name === "LOGTURA_HEARTBEAT_TOKEN") v.value = heartbeatToken;
    if (v.name === "LOGTURA_METRICS_TOKEN") v.value = heartbeatToken;
    if (v.source === "credential") {
      if (!credentialIsFresh) {
        v.staleReason =
          credentialStaleReason ?? "stored credential is unusable";
      }
      if (credentialExpiresAt !== undefined) {
        v.credentialExpiresAt = credentialExpiresAt;
      }
    }
  }

  return {
    deployment,
    bundle,
    input: {...toCoreInput({...generatorInput, connections: perConn.map(c=>({connection:c.connection,selectedSources:c.selectedSources,credentials:c.credentials}))}), runtimeEnv: {LOGTURA_HEARTBEAT_TOKEN: heartbeatToken, LOGTURA_METRICS_TOKEN: heartbeatToken}},
    heartbeatToken,
    credentialIsFresh,
    credentialStaleReason,
    credentialExpiresAt: credentialExpiresAt ?? undefined,
  };
}
