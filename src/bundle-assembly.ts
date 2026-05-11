import {
  type ConnectionRow,
  type DeploymentRow,
  type LogSourceRow,
  decryptConnectionCredentials,
  decryptDestinationConfig,
  ensureHeartbeatToken,
  getDeployment,
  getDestination,
  listConnectionsForDeployment,
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
} from "./generator";
import { getProvider } from "./providers";

export interface AssembledBundle {
  deployment: DeploymentRow;
  bundle: GeneratedBundle;
  heartbeatToken: string;
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

  // Authoritative connection set lives in the deployment_connections
  // join table. deployments.connection_id is still kept as the
  // "primary" for app naming + UX, but bundle assembly uses the
  // join because v1 supports multi-connection deployments.
  const connections = await listConnectionsForDeployment(
    env.DB,
    userId,
    deployment.id,
  );
  if (connections.length === 0) throw new Error("connection not found");

  const selection = parseDeploymentSelection(deployment);

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
    const allSources = await listSources(env.DB, c.id);
    const selectedSources =
      selection.sourceIds === null
        ? allSources
        : allSources.filter((s) => selection.sourceIds!.includes(s.id));
    const credentials =
      await decryptConnectionCredentials<Record<string, unknown>>(env, c);
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
      selectedSources,
      credentials,
      fresh,
      staleReason,
      expiresAt: expiresAt ?? undefined,
    });
  }

  // Monitors are user-scoped (their connection_id is nullable — null
  // means "applies to all connections"). The selection list operates
  // on the merged candidate set across all connections this
  // deployment touches.
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

  const bundle = generateBundle({
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
  });

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
    heartbeatToken,
    credentialIsFresh,
    credentialStaleReason,
    credentialExpiresAt: credentialExpiresAt ?? undefined,
  };
}
