import {
  decryptConnectionCredentials,
  getConnection,
  markDiscovered,
  upsertSources,
} from "../../db";
import { ProviderError, getProvider } from "../../providers";
import type { JobHandlerCtx } from "../queue";
import type { DiscoveryPayload, DiscoveryResult } from "../types";

/** Single-step job. No kids — the work fits comfortably in one
 *  handler invocation under the 25s budget. The shape is just the
 *  new ctx-driven one for consistency with the chained handlers. */
export async function runDiscovery(
  ctx: JobHandlerCtx,
): Promise<DiscoveryResult> {
  const payload = ctx.job.payload as unknown as DiscoveryPayload;
  if (!payload.connectionId) {
    throw new Error("discovery payload missing connectionId");
  }

  const connection = await getConnection(
    ctx.env.DB,
    ctx.job.userId,
    payload.connectionId,
  );
  if (!connection) {
    throw new Error(`connection ${payload.connectionId} not found`);
  }
  if (!connection.external_account_id && connection.provider !== "vercel-logs") {
    throw new Error("connection has no external_account_id");
  }

  const driver = getProvider(connection.provider);
  if (!driver) {
    throw new Error(`unknown provider: ${connection.provider}`);
  }

  const credentials = await decryptConnectionCredentials(ctx.env, connection);

  const startedAt = Date.now();
  let sources;
  try {
    sources = await driver.discoverSources({
      credentials,
      accountId: connection.external_account_id ?? "",
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new Error(
        `${driver.displayName} discovery failed: ${err.message}`,
      );
    }
    throw err;
  }

  await upsertSources(ctx.env.DB, connection.id, sources);
  await markDiscovered(ctx.env.DB, connection.id);

  return {
    sourceCount: sources.length,
    durationMs: Date.now() - startedAt,
  };
}
