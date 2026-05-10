import {
  type DeploymentRow,
  decryptConnectionCredentials,
  decryptDestinationConfig,
  ensureHeartbeatToken,
  getConnection,
  getDeployment,
  getDestination,
  listMonitorsForConnection,
  listSinksForMonitor,
  listSources,
  parseDeploymentSelection,
} from "./db";
import type { Env } from "./env";
import { type GeneratedBundle, generateBundle } from "./generator";
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

  const connection = await getConnection(
    env.DB,
    userId,
    deployment.connection_id,
  );
  if (!connection) throw new Error("connection not found");

  const selection = parseDeploymentSelection(deployment);
  const allSources = await listSources(env.DB, connection.id);
  const selectedSources =
    selection.sourceIds === null
      ? allSources
      : allSources.filter((s) => selection.sourceIds!.includes(s.id));

  const candidateMonitors = await listMonitorsForConnection(
    env.DB,
    userId,
    connection.id,
  );
  const applicableMonitors =
    selection.monitorIds === null
      ? candidateMonitors
      : candidateMonitors.filter((m) =>
          selection.monitorIds!.includes(m.id),
        );

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

  const decryptedCredentials =
    await decryptConnectionCredentials<Record<string, unknown>>(env, connection);

  let credentialIsFresh = true;
  let credentialStaleReason: string | undefined;
  let credentialExpiresAt: number | null | undefined;
  const provider = getProvider(connection.provider);
  if (provider?.checkCredentialFreshness) {
    try {
      const r = await provider.checkCredentialFreshness(decryptedCredentials);
      credentialIsFresh = r.fresh;
      credentialStaleReason = r.reason;
      credentialExpiresAt = r.expiresAt ?? null;
    } catch (err) {
      console.warn("credential freshness check threw", err);
      credentialIsFresh = false;
      credentialStaleReason = "freshness check failed";
    }
  }

  const bundle = generateBundle({
    connection,
    selectedSources,
    monitors: generatorMonitors,
    connectionCredentials: credentialIsFresh ? decryptedCredentials : undefined,
    heartbeat: {
      kind:
        (deployment.heartbeat_target ?? "logtura") === "logtura"
          ? "logtura"
          : "none",
      deploymentId: deployment.id,
      appUrl: env.APP_URL,
    },
  });

  const heartbeatToken = await ensureHeartbeatToken(env.DB, deployment);
  for (const v of bundle.envVars) {
    if (v.name === "LOGTURA_HEARTBEAT_TOKEN") v.value = heartbeatToken;
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
