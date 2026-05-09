import {
  decryptConnectionCredentials,
  getConnection,
  markDiscovered,
  upsertSources,
} from "../../db";
import type { Env } from "../../env";
import { ProviderError, getProvider } from "../../providers";
import type { DiscoveryPayload, DiscoveryResult, JobRecord } from "../types";

export async function runDiscovery(
  env: Env,
  job: JobRecord,
): Promise<DiscoveryResult> {
  const payload = job.payload as unknown as DiscoveryPayload;
  if (!payload.connectionId) {
    throw new Error("discovery payload missing connectionId");
  }

  const connection = await getConnection(env.DB, job.userId, payload.connectionId);
  if (!connection) {
    throw new Error(`connection ${payload.connectionId} not found`);
  }
  if (!connection.external_account_id) {
    throw new Error("connection has no external_account_id");
  }

  const driver = getProvider(connection.provider);
  if (!driver) {
    throw new Error(`unknown provider: ${connection.provider}`);
  }

  const credentials = await decryptConnectionCredentials(env, connection);

  const startedAt = Date.now();
  let sources;
  try {
    sources = await driver.discoverSources({
      credentials,
      accountId: connection.external_account_id,
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new Error(
        `${driver.displayName} discovery failed: ${err.message}`,
      );
    }
    throw err;
  }

  await upsertSources(env.DB, connection.id, sources);
  await markDiscovered(env.DB, connection.id);

  return {
    sourceCount: sources.length,
    durationMs: Date.now() - startedAt,
  };
}
