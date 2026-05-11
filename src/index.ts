import { Hono } from "hono";
import {
  attachOptionalUser,
  finishGithubLogin,
  logout,
  requireAuth,
  startGithubLogin,
} from "./auth";
import {
  createConnection,
  updateConnectionCredentials,
  getConnectionsByIds,
  getSourcesByIdsForUser,
  listAllSourcesForUser,
  markUserDeploymentsOutdated,
  parseDeploymentSelection,
  markDeploymentDeployed,
  createDestination,
  createMonitor,
  createSink,
  decryptConnectionCredentials,
  decryptDestinationConfig,
  deleteConnection,
  deleteDestination,
  deleteMonitor,
  deleteSink,
  ensureDefaultErrorsMonitor,
  getConnection,
  getDestination,
  getMonitor,
  listConnections,
  listDestinations,
  listMonitors,
  listMonitorsForConnection,
  listSinksForMonitor,
  listSinksForUser,
  listSources,
  updateMonitor,
  updateSinkSteps,
  parseFilterSteps,
  recordHeartbeat,
  ensureHeartbeatToken,
  type FilterStep,
  // Deployments — the unit of "what runs"
  createDeployment,
  deleteDeployment,
  getDeployment,
  listDeployments,
  listDeploymentsForConnection,
  decryptDeployTargetCredentials,
  getDeployTargetById,
  listDeployTargets,
  upsertDeployTarget,
  type DeployTargetRow,
  updateDeployment,
  type DeploymentRow,
  type ConnectionRow,
  type DestinationRow,
  type LogSourceRow,
  type MonitorRow,
  type SinkRow,
} from "./db";
import {
  DestinationError,
  getDestinationDriver,
  listDestinationDrivers,
} from "./destinations";
import {
  getDeployTargetDriver,
  listDeployTargetDrivers,
} from "./deploy-targets";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { newToken, signCookie, verifyCookie } from "./crypto";
import type { AppContext, Env } from "./env";
import { generateBundle } from "./generator";
import { assembleDeploymentBundle } from "./bundle-assembly";
import { buildInstallBundle } from "./install-bundle";
import {
  type MetricsSnapshot,
  applyMetricsToSnapshot,
  parseMetricsBody,
} from "./metrics-snapshot";
import { JobDriver, aggregateStatus } from "./jobs/driver";
import { processQueueBatch } from "./jobs/queue";
import {
  deploymentSilenceEmail,
  sendEmail,
} from "./email";
import {
  listStaleDeployments,
  markDeploymentSilenceAlerted,
} from "./db";
import {
  type JobRecord,
  lockKeyForDiscovery,
  lockKeyForFlyDeploy,
  type QueueEnvelope,
} from "./jobs/types";
import { getProvider, listProviders, ProviderError } from "./providers";

const app = new Hono<AppContext>();

app.use("*", attachOptionalUser);

// --- OAuth (server-side redirects) -----------------------------------------

app.get("/login/github", startGithubLogin);
app.get("/auth/github/callback", finishGithubLogin);
app.get("/logout", logout);

// --- JSON API --------------------------------------------------------------

const api = new Hono<AppContext>();

api.get("/me", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null });
  return c.json({
    user: {
      id: user.id,
      githubLogin: user.githubLogin,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    },
  });
});

api.get("/providers", (c) => {
  const providers = listProviders().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    connectFlow: p.connectFlow ?? null,
    formFields: p.formFields,
  }));
  return c.json({ providers });
});

const apiAuth = new Hono<AppContext>();
apiAuth.use("*", requireAuth);

apiAuth.get("/connections", async (c) => {
  const user = c.get("user")!;
  const rows = await listConnections(c.env.DB, user.id);
  return c.json({ connections: rows.map(toApiConnection) });
});

/** Every source visible to the user, across every connection. The
 *  deployment Configure tab's source picker is cross-connection
 *  (connections are derived from the selected source set), so a
 *  single endpoint that returns the whole catalog grouped by
 *  connection is cheaper than N round-trips. */
apiAuth.get("/sources", async (c) => {
  const user = c.get("user")!;
  const [conns, sources] = await Promise.all([
    listConnections(c.env.DB, user.id),
    listAllSourcesForUser(c.env.DB, user.id),
  ]);
  const connMeta = new Map(
    conns.map((cc) => [
      cc.id,
      {
        id: cc.id,
        displayName: cc.display_name,
        provider: cc.provider,
        externalAccountId: cc.external_account_id,
      },
    ]),
  );
  return c.json({
    connections: conns.map((cc) => connMeta.get(cc.id)!),
    sources: sources.map((s) => ({
      id: s.id,
      connectionId: s.connection_id,
      sourceKind: s.source_kind,
      externalId: s.external_id,
      displayName: s.display_name,
    })),
  });
});

apiAuth.post("/connections", async (c) => {
  const user = c.get("user")!;
  const form = await c.req.formData();
  const providerId = String(form.get("provider") ?? "").trim();
  const displayName = String(form.get("display_name") ?? "").trim();
  if (!providerId || !displayName) {
    return c.json({ error: "missing_fields" }, 400);
  }

  const driver = getProvider(providerId);
  if (!driver) return c.json({ error: "unknown_provider" }, 400);

  let credentials: unknown;
  let explicitAccountId: string | null;
  try {
    const parsed = driver.parseFormData(form);
    credentials = parsed.credentials;
    explicitAccountId = parsed.explicitAccountId;
  } catch (err) {
    if (err instanceof ProviderError) {
      return c.json({ error: "invalid_form", message: err.message }, 400);
    }
    throw err;
  }

  let accounts: { id: string; name: string }[];
  try {
    accounts = await driver.verifyCredentials(credentials);
  } catch (err) {
    if (err instanceof ProviderError) {
      return c.json({ error: "verify_failed", message: err.message }, 400);
    }
    throw err;
  }

  let accountId = explicitAccountId;
  if (!accountId) {
    if (accounts.length === 0) {
      return c.json({ error: "no_accounts" }, 400);
    }
    accountId = accounts[0]!.id;
  }

  const connection = await createConnection(c.env.DB, c.env, {
    userId: user.id,
    provider: driver.id,
    displayName,
    externalAccountId: accountId,
    credentials,
  });

  // First-connection nicety: make sure the user has a default
  // "Errors" monitor before discovery returns. Idempotent.
  await ensureDefaultErrorsMonitor(c.env.DB, user.id);

  // Queue an initial discovery instead of running it inline.
  const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  await jobs.enqueue({
    userId: user.id,
    kind: "discovery",
    payload: { connectionId: connection.id },
    lockKey: lockKeyForDiscovery(connection.id),
  });

  return c.json({ connection: toApiConnection(connection) });
});

/**
 * Mint a new connection from an existing deploy_target's bootstrap
 * credential. End state is identical to the paste-token flow above:
 * a connection row with an encrypted `{ apiToken }` blob and an
 * external_account_id. The difference is logtura runs the
 * "create-a-scoped-token" step on the user's behalf via the
 * target driver's `mintConnectionCredentials` rather than having
 * the user run `fly tokens create readonly` themselves.
 *
 * Body: { deployTargetId, providerId, displayName, scope? }
 *   - deployTargetId: which bootstrap to use (Fly cli_session today)
 *   - providerId: which source provider this credential is for
 *   - displayName: free-form label for the new connection
 *   - scope: opaque hint for the driver (Fly: org slug to mint against)
 */
apiAuth.post("/connections/from-bootstrap", async (c) => {
  const user = c.get("user")!;
  const body = (await c.req.json()) as {
    deployTargetId?: string;
    providerId?: string;
    displayName?: string;
    scope?: string;
  };
  if (!body.deployTargetId || !body.providerId || !body.displayName) {
    return c.json({ error: "missing_fields" }, 400);
  }

  const providerDriver = getProvider(body.providerId);
  if (!providerDriver) return c.json({ error: "unknown_provider" }, 400);

  const target = await getDeployTargetById(
    c.env.DB,
    user.id,
    body.deployTargetId,
  );
  if (!target) return c.json({ error: "bootstrap_not_found" }, 404);

  const targetDriver = getDeployTargetDriver(target.kind);
  if (!targetDriver?.mintConnectionCredentials) {
    return c.json(
      {
        error: "bootstrap_no_mint",
        message: `${target.kind} bootstrap can't mint provider credentials`,
      },
      400,
    );
  }

  const bootstrapCreds = await decryptDeployTargetCredentials(c.env, target);

  let minted;
  try {
    minted = await targetDriver.mintConnectionCredentials({
      bootstrapCredentials: bootstrapCreds,
      providerId: body.providerId,
      scope: body.scope,
    });
  } catch (err) {
    console.warn("connection_mint_failed", {
      target_id: target.id,
      target_kind: target.kind,
      provider_id: body.providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        error: "mint_failed",
        message: err instanceof Error ? err.message : "mint failed",
      },
      502,
    );
  }

  // Run the same verifyCredentials the paste path runs, both as a
  // sanity check (did Fly actually give us a usable token?) and to
  // surface a usable account list when the mint didn't include one.
  let accounts: { id: string; name: string }[] = [];
  try {
    accounts = await providerDriver.verifyCredentials({
      apiToken: minted.apiToken,
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      return c.json(
        { error: "mint_verify_failed", message: err.message },
        400,
      );
    }
    throw err;
  }

  const accountId =
    minted.externalAccountId ?? accounts[0]?.id ?? null;
  if (!accountId) {
    return c.json({ error: "no_accounts" }, 400);
  }

  const connection = await createConnection(c.env.DB, c.env, {
    userId: user.id,
    provider: providerDriver.id,
    displayName: body.displayName,
    externalAccountId: accountId,
    credentials: { apiToken: minted.apiToken },
  });

  await ensureDefaultErrorsMonitor(c.env.DB, user.id);

  const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  await jobs.enqueue({
    userId: user.id,
    kind: "discovery",
    payload: { connectionId: connection.id },
    lockKey: lockKeyForDiscovery(connection.id),
  });

  return c.json({ connection: toApiConnection(connection) });
});

apiAuth.get("/connections/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const connection = await getConnection(c.env.DB, user.id, id);
  if (!connection) return c.json({ error: "not_found" }, 404);
  const sources = await listSources(c.env.DB, connection.id);
  const driver = getProvider(connection.provider);
  const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  const latestJob = await jobs.latestForLockKey(
    lockKeyForDiscovery(connection.id),
  );
  return c.json({
    connection: toApiConnection(connection),
    sources: sources.map((s) => toApiSource(s, driver)),
    latestDiscoveryJob: latestJob ? toApiJob(latestJob) : null,
  });
});

apiAuth.post("/connections/:id/discover", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const connection = await getConnection(c.env.DB, user.id, id);
  if (!connection) return c.json({ error: "not_found" }, 404);
  if (!connection.external_account_id) {
    return c.json({ error: "no_account_id" }, 400);
  }
  const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  const result = await jobs.enqueue({
    userId: user.id,
    kind: "discovery",
    payload: { connectionId: connection.id },
    lockKey: lockKeyForDiscovery(connection.id),
  });
  return c.json({
    job: toApiJob(result.job),
    deduped: result.deduped,
  });
});

apiAuth.delete("/connections/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  await deleteConnection(c.env.DB, user.id, id);
  return c.json({ ok: true });
});

// Reconnect: swap credentials in place. Same form payload as create,
// minus `provider` (the provider is fixed by the existing row). Used
// when the user rotated a token or added missing scopes, so existing
// deployments / monitors / sinks pointing at this connection keep
// working with no migration.
apiAuth.post("/connections/:id/reconnect", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const existing = await getConnection(c.env.DB, user.id, id);
  if (!existing) return c.json({ error: "not_found" }, 404);

  const driver = getProvider(existing.provider);
  if (!driver) return c.json({ error: "unknown_provider" }, 400);

  const form = await c.req.formData();
  let credentials: unknown;
  let explicitAccountId: string | null;
  try {
    const parsed = driver.parseFormData(form);
    credentials = parsed.credentials;
    explicitAccountId = parsed.explicitAccountId;
  } catch (err) {
    if (err instanceof ProviderError) {
      return c.json({ error: "invalid_form", message: err.message }, 400);
    }
    throw err;
  }

  // Verify the new credentials work before clobbering the stored
  // ones. If they don't, the connection stays usable on the old
  // token (the user can try again without breakage).
  let accounts: { id: string; name: string }[];
  try {
    accounts = await driver.verifyCredentials(credentials);
  } catch (err) {
    if (err instanceof ProviderError) {
      return c.json({ error: "verify_failed", message: err.message }, 400);
    }
    throw err;
  }

  // Prefer the explicit account id from the form; fall back to the
  // existing row's so a token-only rotation doesn't drop it.
  let accountId = explicitAccountId ?? existing.external_account_id;
  if (!accountId && accounts.length > 0) accountId = accounts[0]!.id;

  const displayNameRaw = form.get("display_name");
  const displayName =
    typeof displayNameRaw === "string" && displayNameRaw.trim()
      ? displayNameRaw.trim()
      : null;

  const updated = await updateConnectionCredentials(
    c.env.DB,
    c.env,
    user.id,
    id,
    {
      credentials,
      externalAccountId: accountId,
      displayName,
    },
  );
  if (!updated) return c.json({ error: "not_found" }, 404);

  // Re-discover sources — new scopes might mean we can see things
  // we couldn't before (e.g., AI Gateway after a Workers-only token
  // is upgraded).
  const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  await jobs.enqueue({
    userId: user.id,
    kind: "discovery",
    payload: { connectionId: updated.id },
    lockKey: lockKeyForDiscovery(updated.id),
  });

  // Credentials changed → every deployment on this user's account
  // has an out-of-date bundle. The Redeploy CTA appears.
  await markUserDeploymentsOutdated(c.env.DB, user.id);

  return c.json({ connection: toApiConnection(updated) });
});

apiAuth.get("/deployments/:id/bundle", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  let assembled;
  try {
    assembled = await assembleDeploymentBundle(c.env, user.id, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "bundle failed";
    if (message.includes("deployment not found"))
      return c.json({ error: "not_found" }, 404);
    if (message.includes("connection not found"))
      return c.json({ error: "connection_not_found" }, 404);
    // Same-provider env-var collision (two CF connections, two
    // FLY_API_TOKEN, etc.) is a configuration problem the user can
    // fix from the picker — surface it as a 400 with the actual
    // reason instead of a bare 500. The error message names the
    // provider so the UI can highlight which source set to
    // narrow.
    if (message.includes("only one connection per provider")) {
      return c.json(
        { error: "duplicate_provider_sources", message },
        400,
      );
    }
    throw err;
  }
  const { deployment, bundle: sourceBundle } = assembled;

  const targetId = (c.req.query("target") ?? deployment.target_kind).trim();
  const targetDriver = getDeployTargetDriver(targetId);
  if (!targetDriver) {
    return c.json({ error: "unknown_target" }, 400);
  }
  const region = c.req.query("region") ?? undefined;

  const targetBundle = targetDriver.generateTargetBundle({
    sourceBundle,
    deploymentName: deployment.display_name,
    region,
    connectionId: deployment.connection_id,
  });

  return c.json({
    target: {
      id: targetDriver.id,
      displayName: targetDriver.displayName,
      supportsManaged: targetDriver.supportsManaged,
    },
    files: targetBundle.files,
    selfDeployInstructions: targetBundle.selfDeployInstructions,
    envVars: sourceBundle.envVars,
    selectedCount: sourceBundle.selectedCount,
    monitorSummary: sourceBundle.monitorSummary,
    componentManifest: sourceBundle.componentManifest,
  });
});

// ----- Install bundle (self-deploy tarball) ----------------------------
//
// Two surfaces share one composer:
//   1. Session-authed download — the "Download install bundle" button.
//      Returns a streamable .tgz.
//   2. Signed one-shot URL — the "Generate install command" button mints
//      a URL with an HMAC-signed payload {deploymentId, userId, exp}.
//      Public endpoint verifies + serves the same .tgz. 60s TTL is the
//      replay defense; no DB rows needed.

apiAuth.get("/deployments/:id/install-bundle.tgz", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const deployment = await getDeployment(c.env.DB, user.id, id);
  if (!deployment) return c.json({ error: "not_found" }, 404);
  const { filename, bytes } = await buildInstallBundle(c.env, user.id, id);
  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
});

apiAuth.post("/deployments/:id/install-bundle/sign", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const deployment = await getDeployment(c.env.DB, user.id, id);
  if (!deployment) return c.json({ error: "not_found" }, 404);
  const exp = Date.now() + 60_000; // 60s window
  const payload = JSON.stringify({ d: id, u: user.id, exp });
  const signed = await signCookie(payload, c.env.SESSION_SECRET);
  const url = `${c.env.APP_URL}/api/install-bundle/${encodeURIComponent(signed)}/${encodeURIComponent(deployment.display_name.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "logtura")}.tgz`;
  return c.json({ url, expiresAt: exp });
});

// Public, signature-verified bundle download. URL embeds the signed
// payload + a cosmetic filename suffix (so `curl -O` produces a
// readable name). The filename suffix is NOT trusted; we recompute
// it from the deployment's display_name server-side.
api.get("/install-bundle/:signed/:_filename", async (c) => {
  const signed = c.req.param("signed");
  const raw = await verifyCookie(signed, c.env.SESSION_SECRET);
  if (!raw) return c.json({ error: "invalid_signature" }, 401);
  let payload: { d?: string; u?: string; exp?: number };
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_payload" }, 401);
  }
  if (!payload.d || !payload.u || !payload.exp) {
    return c.json({ error: "invalid_payload" }, 401);
  }
  if (Date.now() > payload.exp) {
    return c.json({ error: "expired" }, 410);
  }
  // Re-verify the deployment exists for the named user (defense in
  // depth — if SESSION_SECRET ever rotates mid-flight the signature
  // check above is the gate, but cheap to also confirm the row).
  const deployment = await getDeployment(c.env.DB, payload.u, payload.d);
  if (!deployment) return c.json({ error: "not_found" }, 404);
  const { filename, bytes } = await buildInstallBundle(
    c.env,
    payload.u,
    payload.d,
  );
  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
});

// ----- Deployment CRUD -------------------------------------------------

apiAuth.get("/deployments", async (c) => {
  const user = c.get("user")!;
  const rows = await listDeployments(c.env.DB, user.id);
  return c.json({ deployments: rows.map(toApiDeployment) });
});

apiAuth.get("/deploy-targets", async (c) => {
  const user = c.get("user")!;
  const rows = await listDeployTargets(c.env.DB, user.id);
  return c.json({
    deployTargets: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      displayName: r.display_name,
      externalAccountId: r.external_account_id,
      // Surface what source providers this bootstrap can mint
      // for — used by the New Connection UI to light up the
      // "use existing X connection" card. Belt-and-suspenders:
      // the server-side mint route also enforces the check.
      mintsForProviders:
        getDeployTargetDriver(r.kind)?.mintsForProviders ?? [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

apiAuth.get("/connections/:id/deployments", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const rows = await listDeploymentsForConnection(c.env.DB, user.id, id);
  return c.json({ deployments: rows.map(toApiDeployment) });
});

apiAuth.post("/deployments", async (c) => {
  const user = c.get("user")!;
  const body = (await c.req.json()) as {
    /** Optional anchor connection — used as deployments.connection_id
     *  for app naming + as the fallback when sourceIds is null. The
     *  real connection set is derived from the selected sources;
     *  this field just seeds the deployment in the common "I just
     *  connected CF, deploy with all its sources" wizard flow. */
    connectionId?: string;
    displayName?: string;
    targetKind?: string;
    managed?: boolean;
    sourceIds?: string[] | null;
    monitorIds?: string[] | null;
    heartbeatTarget?: string | null;
  };
  if (!body.connectionId || !body.displayName || !body.targetKind) {
    return c.json({ error: "missing_fields" }, 400);
  }
  if (!getDeployTargetDriver(body.targetKind)) {
    return c.json({ error: "unknown_target" }, 400);
  }
  const conn = await getConnection(c.env.DB, user.id, body.connectionId);
  if (!conn) {
    return c.json({ error: "connection_not_found" }, 404);
  }
  const deployment = await createDeployment(c.env.DB, {
    userId: user.id,
    connectionId: body.connectionId,
    displayName: body.displayName,
    targetKind: body.targetKind,
    managed: body.managed,
    sourceIds: body.sourceIds === undefined ? null : body.sourceIds,
    monitorIds: body.monitorIds === undefined ? null : body.monitorIds,
    heartbeatTarget: body.heartbeatTarget ?? null,
  });
  return c.json({ deployment: toApiDeployment(deployment) });
});

apiAuth.get("/deployments/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const deployment = await getDeployment(c.env.DB, user.id, id);
  if (!deployment) return c.json({ error: "not_found" }, 404);
  // Rehydrate any in-flight deploy job by lock key so a page reload
  // mid-deploy can resume polling instead of forgetting the job.
  // `activeForLockKey` considers the chain (parent + kids), and we
  // run the same kid-aggregation `/jobs/:id` does so the front-end
  // sees status=running and the latest progress label — not the raw
  // parent row, which goes to succeeded within ms of spawning kid 1.
  const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  const activeParent = await jobs.activeForLockKey(lockKeyForFlyDeploy(id));
  let latestDeployJob = null;
  if (activeParent) {
    const { job } = await aggregateJobWithKids(jobs, activeParent);
    latestDeployJob = toApiJob(job);
  }
  // Surface the deployment's connection set so the configure tab
  // can label sources by their owning connection. Derived from
  // selected sources rather than a join table — a deployment IS
  // its source set; connections come along automatically.
  const selection = parseDeploymentSelection(deployment);
  let derivedConnIds: string[] = [];
  if (selection.sourceIds && selection.sourceIds.length > 0) {
    const sources = await getSourcesByIdsForUser(
      c.env.DB,
      user.id,
      selection.sourceIds,
    );
    derivedConnIds = Array.from(new Set(sources.map((s) => s.connection_id)));
  } else if (deployment.connection_id) {
    // null selection = "all sources from the anchor connection".
    derivedConnIds = [deployment.connection_id];
  }
  const conns = await getConnectionsByIds(c.env.DB, user.id, derivedConnIds);
  return c.json({
    deployment: toApiDeployment(deployment),
    latestDeployJob,
    connections: conns.map((cc) => ({
      id: cc.id,
      displayName: cc.display_name,
      provider: cc.provider,
      externalAccountId: cc.external_account_id,
    })),
  });
});

apiAuth.put("/deployments/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = (await c.req.json()) as {
    displayName?: string;
    managed?: boolean;
    sourceIds?: string[] | null;
    monitorIds?: string[] | null;
    heartbeatTarget?: string | null;
    metricsTarget?: string | null;
    status?: string;
    externalId?: string | null;
  };
  // Sanity-check target values. heartbeat is currently logs+ping
  // only ("logtura" | "none"); metrics can target any destination
  // whose driver declares the "metrics" flow.
  if (
    body.metricsTarget &&
    body.metricsTarget !== "none" &&
    body.metricsTarget !== "logtura"
  ) {
    const dest = await c.env.DB.prepare(
      "SELECT kind FROM destinations WHERE id = ? AND user_id = ?",
    )
      .bind(body.metricsTarget, user.id)
      .first<{ kind: string }>();
    if (!dest) {
      return c.json({ error: "metrics_target_not_found" }, 400);
    }
    const driver = getDestinationDriver(dest.kind);
    if (!driver || !driver.flows.includes("metrics")) {
      return c.json(
        { error: "metrics_target_flow_mismatch", kind: dest.kind },
        400,
      );
    }
  }
  const updated = await updateDeployment(c.env.DB, user.id, id, body as never);
  if (!updated) return c.json({ error: "not_found" }, 404);
  // Treat anything that changed the bundle inputs as making the
  // running container stale. status/externalId-only updates are
  // status bookkeeping (set by the deploy chain itself) and don't
  // need the flag flipped.
  const touchesBundle =
    body.displayName !== undefined ||
    body.sourceIds !== undefined ||
    body.monitorIds !== undefined ||
    body.heartbeatTarget !== undefined ||
    body.metricsTarget !== undefined;
  if (touchesBundle) {
    await markUserDeploymentsOutdated(c.env.DB, user.id);
  }
  return c.json({ deployment: toApiDeployment(updated) });
});

apiAuth.post("/deployments/:id/mark-deployed", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const existing = await getDeployment(c.env.DB, user.id, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await markDeploymentDeployed(c.env.DB, user.id, id);
  const updated = await getDeployment(c.env.DB, user.id, id);
  return c.json({ deployment: updated ? toApiDeployment(updated) : null });
});

apiAuth.delete("/deployments/:id", async (c) => {
  const user = c.get("user")!;
  await deleteDeployment(c.env.DB, user.id, c.req.param("id"));
  return c.json({ ok: true });
});

apiAuth.post("/deployments/:id/deploy", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const deployment = await getDeployment(c.env.DB, user.id, id);
  if (!deployment) return c.json({ error: "not_found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    deployTargetId?: string;
    region?: string;
  };
  if (!body.deployTargetId) {
    return c.json({ error: "missing_deploy_target" }, 400);
  }
  const target = await getDeployTargetById(
    c.env.DB,
    user.id,
    body.deployTargetId,
  );
  if (!target) return c.json({ error: "deploy_target_not_found" }, 404);
  if (target.kind !== deployment.target_kind) {
    return c.json(
      {
        error: "target_kind_mismatch",
        expected: deployment.target_kind,
        got: target.kind,
      },
      400,
    );
  }

  const driver = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  const { job, deduped } = await driver.enqueue({
    userId: user.id,
    kind: "fly_deploy",
    payload: {
      deploymentId: id,
      deployTargetId: target.id,
      region: body.region,
    },
    lockKey: lockKeyForFlyDeploy(id),
  });
  if (!deduped) {
    await updateDeployment(c.env.DB, user.id, id, { status: "pending" });
  }
  return c.json({ job: toApiJob(job), deduped });
});

// ----- Heartbeat ingest (no user auth — bearer token per deployment) ----

api.post("/heartbeat/:id", async (c) => {
  const id = c.req.param("id");
  const auth = c.req.header("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!presented) return c.json({ error: "missing_token" }, 401);

  // Pull the row directly (no user_id constraint — the deployment ID
  // + bearer token is the auth pair). Constant-time-ish compare.
  const row = await c.env.DB.prepare(
    "SELECT id, heartbeat_token FROM deployments WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; heartbeat_token: string | null }>();
  if (!row || !row.heartbeat_token) {
    return c.json({ error: "not_found" }, 404);
  }
  if (!constantTimeEqual(row.heartbeat_token, presented)) {
    return c.json({ error: "invalid_token" }, 401);
  }
  await recordHeartbeat(c.env.DB, id);
  return c.body(null, 204);
});

// Metrics ingest. Same auth pair as heartbeat (deployment id +
// bearer token). We don't store the time series — that's where money
// goes — but we DO maintain a fixed-memory snapshot of the latest
// counter values per component, so the UI can show "is anything
// flowing, are deliveries succeeding, when did each component last
// emit." See src/metrics-snapshot.ts for the merge logic.
api.post("/metrics/:id", async (c) => {
  const id = c.req.param("id");
  const auth = c.req.header("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!presented) return c.json({ error: "missing_token" }, 401);
  const row = await c.env.DB.prepare(
    "SELECT id, heartbeat_token, metrics_snapshot_json FROM deployments WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      heartbeat_token: string | null;
      metrics_snapshot_json: string | null;
    }>();
  if (!row || !row.heartbeat_token) {
    return c.json({ error: "not_found" }, 404);
  }
  if (!constantTimeEqual(row.heartbeat_token, presented)) {
    return c.json({ error: "invalid_token" }, 401);
  }
  let body = "";
  try {
    body = await c.req.text();
  } catch {
    // empty body — still record liveness below
  }
  const events = parseMetricsBody(body);
  if (events.length > 0) {
    const prevSnap = row.metrics_snapshot_json
      ? (JSON.parse(row.metrics_snapshot_json) as MetricsSnapshot)
      : null;
    const next = applyMetricsToSnapshot(prevSnap, events);
    await c.env.DB.prepare(
      "UPDATE deployments SET metrics_snapshot_json = ?, last_seen_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(JSON.stringify(next), Date.now(), Date.now(), id)
      .run();
  } else {
    // Body absent or malformed; treat as a plain liveness ping.
    await recordHeartbeat(c.env.DB, id);
  }
  // Vector will resend on 5xx, so always 2xx for a valid token.
  return c.body(null, 204);
});

// ----- Fly cli_session click-flow connect -----------------------------

const FLY_SESSION_COOKIE = "logtura_fly_session";

apiAuth.post("/deploy-targets/fly/start", async (c) => {
  const user = c.get("user")!;
  // Fly's session API is unauthenticated — we POST and get back an
  // auth_url + id. Same flow `flyctl auth login` uses.
  const res = await fetch("https://api.fly.io/api/v1/cli_sessions", {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    return c.json(
      { error: "fly_start_failed", status: res.status },
      502,
    );
  }
  const data = (await res.json()) as { id?: string; auth_url?: string };
  if (!data.id || !data.auth_url) {
    return c.json({ error: "fly_unexpected_response" }, 502);
  }
  // Stamp the session id into a signed cookie so the poll endpoint
  // can verify it came from us (defense against a rogue user
  // polling someone else's session id).
  const signed = await signCookie(
    JSON.stringify({ sessionId: data.id, userId: user.id }),
    c.env.SESSION_SECRET,
  );
  setCookie(c, FLY_SESSION_COOKIE, signed, {
    httpOnly: true,
    secure: c.env.APP_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: 900,
  });
  return c.json({ sessionId: data.id, authUrl: data.auth_url });
});

apiAuth.get("/deploy-targets/fly/poll", async (c) => {
  const user = c.get("user")!;
  const requested = c.req.query("session_id") ?? "";
  const stateRaw = await verifyCookie(
    getCookie(c, FLY_SESSION_COOKIE),
    c.env.SESSION_SECRET,
  );
  const state = (() => {
    if (!stateRaw) return null;
    try {
      return JSON.parse(stateRaw) as { sessionId?: string; userId?: string };
    } catch {
      return null;
    }
  })();
  if (
    !state ||
    state.sessionId !== requested ||
    state.userId !== user.id
  ) {
    return c.json({ error: "session_mismatch" }, 400);
  }
  const res = await fetch(
    `https://api.fly.io/api/v1/cli_sessions/${encodeURIComponent(requested)}`,
    { headers: { accept: "application/json" } },
  );
  // Fly returns 404 until the user approves at auth_url — that's the
  // expected "still waiting" state, not a failure. flyctl polls the
  // same endpoint and retries on 404.
  if (res.status === 404) {
    return c.json({ status: "pending" });
  }
  if (!res.ok) {
    return c.json(
      { error: "fly_poll_failed", status: res.status },
      502,
    );
  }
  const data = (await res.json()) as {
    id?: string;
    access_token?: string;
    state?: string;
    user_email?: string;
  };
  if (!data.access_token) {
    return c.json({ status: "pending" });
  }

  // Token in hand — store as a deploy_target. orgSlug isn't part of
  // the cli_sessions response, so we use 'personal' as a placeholder
  // until we add an org picker.
  const target = await upsertDeployTarget(c.env.DB, c.env, {
    userId: user.id,
    kind: "fly",
    displayName: data.user_email ?? "Fly account",
    externalAccountId: "personal",
    credentials: { apiToken: data.access_token },
  });
  deleteCookie(c, FLY_SESSION_COOKIE, { path: "/" });
  return c.json({
    status: "connected",
    deployTargetId: target.id,
    displayName: target.display_name,
  });
});

apiAuth.get("/deploy-targets/drivers", (c) => {
  const drivers = listDeployTargetDrivers().map((d) => ({
    id: d.id,
    displayName: d.displayName,
    description: d.description,
    supportsManaged: d.supportsManaged,
    connectFlow: d.connectFlow ?? null,
    formFields: d.formFields,
  }));
  return c.json({ drivers });
});

// ---------- Destinations -------------------------------------------------

apiAuth.get("/destinations", async (c) => {
  const user = c.get("user")!;
  const rows = await listDestinations(c.env.DB, user.id);
  return c.json({ destinations: rows.map(toApiDestination) });
});

apiAuth.get("/destinations/drivers", (c) => {
  const drivers = listDestinationDrivers().map((d) => ({
    id: d.id,
    displayName: d.displayName,
    description: d.description,
    connectFlow: d.connectFlow ?? null,
    formFields: d.formFields,
  }));
  return c.json({ drivers });
});

apiAuth.post("/destinations", async (c) => {
  const user = c.get("user")!;
  const form = await c.req.formData();
  const kind = String(form.get("kind") ?? "").trim();
  const displayName = String(form.get("display_name") ?? "").trim();
  if (!kind || !displayName) {
    return c.json({ error: "missing_fields" }, 400);
  }
  const driver = getDestinationDriver(kind);
  if (!driver) return c.json({ error: "unknown_driver" }, 400);
  let parsed;
  try {
    parsed = driver.parseFormData(form);
  } catch (err) {
    if (err instanceof DestinationError) {
      return c.json({ error: "invalid_form", message: err.message }, 400);
    }
    throw err;
  }
  if (driver.verifyConfig) {
    try {
      await driver.verifyConfig(parsed.config);
    } catch (err) {
      if (err instanceof DestinationError) {
        return c.json(
          { error: "verify_failed", message: err.message },
          400,
        );
      }
      throw err;
    }
  }
  const destination = await createDestination(c.env.DB, c.env, {
    userId: user.id,
    kind,
    displayName,
    config: parsed.config,
  });
  // New destination can immediately be picked up by wildcard
  // metrics_target or by future sinks; coarse-mark is fine.
  await markUserDeploymentsOutdated(c.env.DB, user.id);
  return c.json({ destination: toApiDestination(destination) });
});

apiAuth.delete("/destinations/:id", async (c) => {
  const user = c.get("user")!;
  await deleteDestination(c.env.DB, user.id, c.req.param("id"));
  await markUserDeploymentsOutdated(c.env.DB, user.id);
  return c.json({ ok: true });
});

// ---------- Slack OAuth (destination kind = "slack") ---------------------

const SLACK_STATE_COOKIE = "logtura_slack_state";

api.get("/destinations/slack/start", async (c) => {
  // Auth required; we set the user-id into the state so the callback
  // (which arrives without our session intentionally — Slack redirects
  // independently of the user's browser session) can reattach to the
  // right user.
  const userCookie = getCookie(c, "logtura_session");
  const userId = userCookie
    ? await verifyCookie(userCookie, c.env.SESSION_SECRET)
    : null;
  if (!userId) return c.redirect("/?error=auth_required", 303);

  if (!c.env.SLACK_CLIENT_ID) {
    return c.redirect(
      "/app/destinations?error=slack_not_configured",
      303,
    );
  }
  const state = newToken();
  const signed = await signCookie(
    JSON.stringify({ state, userId }),
    c.env.SESSION_SECRET,
  );
  setCookie(c, SLACK_STATE_COOKIE, signed, {
    httpOnly: true,
    secure: c.env.APP_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", c.env.SLACK_CLIENT_ID);
  url.searchParams.set("scope", "incoming-webhook");
  url.searchParams.set("user_scope", "");
  url.searchParams.set(
    "redirect_uri",
    `${c.env.APP_URL}/api/destinations/slack/callback`,
  );
  url.searchParams.set("state", state);
  return c.redirect(url.toString(), 303);
});

api.get("/destinations/slack/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const stateCookie = getCookie(c, SLACK_STATE_COOKIE);
  const stateJson = await verifyCookie(stateCookie, c.env.SESSION_SECRET);
  deleteCookie(c, SLACK_STATE_COOKIE, { path: "/" });
  if (!code || !state || !stateJson) {
    return c.redirect("/app/destinations?error=oauth_state", 303);
  }
  const parsed = (() => {
    try {
      return JSON.parse(stateJson) as { state?: string; userId?: string };
    } catch {
      return null;
    }
  })();
  if (!parsed || parsed.state !== state || !parsed.userId) {
    return c.redirect("/app/destinations?error=oauth_state", 303);
  }
  if (!c.env.SLACK_CLIENT_ID || !c.env.SLACK_CLIENT_SECRET) {
    return c.redirect(
      "/app/destinations?error=slack_not_configured",
      303,
    );
  }
  // Exchange code for incoming webhook URL.
  const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: c.env.SLACK_CLIENT_ID,
      client_secret: c.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: `${c.env.APP_URL}/api/destinations/slack/callback`,
    }).toString(),
  });
  const payload = (await tokenRes.json()) as {
    ok?: boolean;
    error?: string;
    incoming_webhook?: { url?: string; channel?: string };
    team?: { name?: string };
  };
  if (!payload.ok || !payload.incoming_webhook?.url) {
    console.error("slack oauth exchange failed", payload);
    return c.redirect("/app/destinations?error=slack_exchange", 303);
  }
  const teamName = payload.team?.name ?? null;
  const channel = payload.incoming_webhook.channel ?? null;
  const displayName = teamName
    ? channel
      ? `${teamName} #${channel.replace(/^#/, "")}`
      : teamName
    : "Slack";
  await createDestination(c.env.DB, c.env, {
    userId: parsed.userId,
    kind: "slack",
    displayName,
    config: {
      webhookUrl: payload.incoming_webhook.url,
      teamName,
      channel,
    },
  });
  return c.redirect("/app/destinations?notice=slack_connected", 303);
});

// ---------- Monitors -----------------------------------------------------

apiAuth.get("/monitors", async (c) => {
  const user = c.get("user")!;
  const monitors = await listMonitors(c.env.DB, user.id);
  const sinks = await listSinksForUser(c.env.DB, user.id);
  return c.json({
    monitors: monitors.map((m) => toApiMonitor(m)),
    sinks: sinks.map((s) => toApiSink(s)),
  });
});

apiAuth.post("/monitors", async (c) => {
  const user = c.get("user")!;
  const body = (await c.req.json()) as {
    displayName?: string;
    filterSteps?: FilterStep[];
    connectionId?: string | null;
    enabled?: boolean;
  };
  if (!body.displayName) {
    return c.json({ error: "missing_fields" }, 400);
  }
  const monitor = await createMonitor(c.env.DB, {
    userId: user.id,
    connectionId: body.connectionId ?? null,
    displayName: body.displayName,
    filterSteps: body.filterSteps ?? [],
    enabled: body.enabled,
  });
  await markUserDeploymentsOutdated(c.env.DB, user.id);
  return c.json({ monitor: toApiMonitor(monitor) });
});

apiAuth.put("/monitors/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = (await c.req.json()) as {
    displayName?: string;
    filterSteps?: FilterStep[];
    connectionId?: string | null;
    enabled?: boolean;
  };
  const updated = await updateMonitor(c.env.DB, user.id, id, body);
  if (!updated) return c.json({ error: "not_found" }, 404);
  await markUserDeploymentsOutdated(c.env.DB, user.id);
  return c.json({ monitor: toApiMonitor(updated) });
});

apiAuth.delete("/monitors/:id", async (c) => {
  const user = c.get("user")!;
  await deleteMonitor(c.env.DB, user.id, c.req.param("id"));
  await markUserDeploymentsOutdated(c.env.DB, user.id);
  return c.json({ ok: true });
});

apiAuth.post("/monitors/:id/sinks", async (c) => {
  const user = c.get("user")!;
  const monitorId = c.req.param("id");
  const monitor = await getMonitor(c.env.DB, user.id, monitorId);
  if (!monitor) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json()) as {
    destinationId?: string;
    filterSteps?: FilterStep[];
  };
  if (!body.destinationId) {
    return c.json({ error: "missing_destination" }, 400);
  }
  const dest = await getDestination(c.env.DB, user.id, body.destinationId);
  if (!dest) return c.json({ error: "destination_not_found" }, 404);
  const sink = await createSink(c.env.DB, {
    monitorId,
    destinationId: body.destinationId,
    filterSteps: body.filterSteps,
  });
  await markUserDeploymentsOutdated(c.env.DB, user.id);
  return c.json({ sink: toApiSink(sink) });
});

apiAuth.put("/sinks/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = (await c.req.json()) as { filterSteps?: FilterStep[] };
  await updateSinkSteps(c.env.DB, user.id, id, body.filterSteps ?? []);
  await markUserDeploymentsOutdated(c.env.DB, user.id);
  return c.json({ ok: true });
});

apiAuth.delete("/sinks/:id", async (c) => {
  const user = c.get("user")!;
  await deleteSink(c.env.DB, user.id, c.req.param("id"));
  await markUserDeploymentsOutdated(c.env.DB, user.id);
  return c.json({ ok: true });
});

/** Roll up a parent job's view from its kids without writing to the
 *  parent row. The kid that "really did the work" (the last
 *  succeeded one) is the source of truth for `result`; the first
 *  failed kid's error wins for `lastError`. Progress comes from
 *  whichever kid is currently in-flight, falling back to the latest
 *  kid that set progress at all so the UI never goes blank. Used by
 *  `/jobs/:id` and any rehydration path that returns an in-flight
 *  job alongside a resource. */
async function aggregateJobWithKids(
  jobs: JobDriver,
  parent: JobRecord,
): Promise<{ job: JobRecord; kids: JobRecord[] }> {
  const kids = await jobs.listChildren(parent.id);
  if (!kids.length) return { job: parent, kids };
  const aggregated: JobRecord = {
    ...parent,
    status: aggregateStatus(parent, kids),
  };
  const failed = kids.find((k) => k.status === "failed");
  const lastSucceeded = [...kids]
    .reverse()
    .find((k) => k.status === "succeeded");
  aggregated.lastError = failed?.lastError ?? null;
  aggregated.result = lastSucceeded?.result ?? null;

  const running = kids.find((k) => k.status === "running");
  const latestWithProgress = [...kids]
    .reverse()
    .find((k) => k.uxProgress !== null);
  aggregated.uxProgress =
    running?.uxProgress ?? latestWithProgress?.uxProgress ?? null;
  return { job: aggregated, kids };
}

apiAuth.get("/jobs/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  const job = await jobs.getById(id);
  if (!job || job.userId !== user.id) {
    return c.json({ error: "not_found" }, 404);
  }
  const { job: aggregated, kids } = await aggregateJobWithKids(jobs, job);
  return c.json({ job: toApiJob(aggregated), kids: kids.map(toApiJob) });
});

api.route("/", apiAuth);
app.route("/api", api);

// --- SPA fallback ---------------------------------------------------------

app.notFound(async (c) => c.env.ASSETS.fetch(c.req.raw));

// --- Worker entry: fetch + queue ------------------------------------------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(req, env, ctx);
  },
  async queue(
    batch: MessageBatch<QueueEnvelope>,
    env: Env,
  ): Promise<void> {
    await processQueueBatch(batch, env);
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runSilenceAlerter(env));
  },
};

/**
 * Silence-alert cron tick. Finds running deployments whose last
 * heartbeat is older than 10 minutes and that we haven't alerted on
 * in the last hour, marks them crashed, and emails the user.
 */
async function runSilenceAlerter(env: Env): Promise<void> {
  const SILENCE_MS = 10 * 60 * 1000;
  const RECENT_ALERT_MS = 60 * 60 * 1000;
  const stale = await listStaleDeployments(
    env.DB,
    SILENCE_MS,
    RECENT_ALERT_MS,
  );
  if (stale.length === 0) return;
  console.log("silence_alerter_found", stale.length);
  for (const d of stale) {
    const user = await env.DB.prepare(
      "SELECT email FROM users WHERE id = ?",
    )
      .bind(d.user_id)
      .first<{ email: string | null }>();
    if (user?.email) {
      const { subject, textBody } = deploymentSilenceEmail({
        deploymentId: d.id,
        displayName: d.display_name,
        lastSeenAt: d.last_seen_at,
        appUrl: env.APP_URL,
      });
      await sendEmail(env, { to: user.email, subject, textBody });
    }
    await markDeploymentSilenceAlerted(env.DB, d.id);
  }
}

// --- API response shapers -------------------------------------------------

function toApiConnection(c: ConnectionRow) {
  return {
    id: c.id,
    provider: c.provider,
    displayName: c.display_name,
    externalAccountId: c.external_account_id,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    lastDiscoveredAt: c.last_discovered_at,
  };
}

function toApiSource(
  s: LogSourceRow,
  driver: ReturnType<typeof getProvider>,
) {
  return {
    id: s.id,
    sourceKind: s.source_kind,
    sourceKindLabel: driver?.sourceLabel ?? s.source_kind,
    externalId: s.external_id,
    displayName: s.display_name,
    metadata: s.metadata_json ? JSON.parse(s.metadata_json) : null,
    discoveredAt: s.discovered_at,
  };
}

function toApiDeployment(d: DeploymentRow) {
  return {
    id: d.id,
    connectionId: d.connection_id,
    displayName: d.display_name,
    targetKind: d.target_kind,
    managed: d.managed === 1,
    status: d.status,
    externalId: d.external_id,
    sourceIds: d.source_selection_json
      ? (JSON.parse(d.source_selection_json) as string[])
      : null,
    monitorIds: d.monitor_selection_json
      ? (JSON.parse(d.monitor_selection_json) as string[])
      : null,
    heartbeatTarget: d.heartbeat_target,
    metricsTarget: d.metrics_target,
    metricsSnapshot: d.metrics_snapshot_json
      ? (JSON.parse(d.metrics_snapshot_json) as MetricsSnapshot)
      : null,
    bundleOutdated: d.bundle_outdated === 1,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    lastSeenAt: d.last_seen_at,
  };
}

function toApiDestination(d: DestinationRow) {
  // flows is driven by the destination's kind, not the row — it's
  // static per-driver. We surface it on the API so the UI can filter
  // destinations by what flow the user is currently configuring
  // (metrics_target dropdown only shows destinations whose driver
  // declares the "metrics" flow).
  const driver = getDestinationDriver(d.kind);
  return {
    id: d.id,
    kind: d.kind,
    displayName: d.display_name,
    flows: driver?.flows ?? ["logs"],
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function toApiMonitor(m: MonitorRow) {
  return {
    id: m.id,
    connectionId: m.connection_id,
    displayName: m.display_name,
    filterSteps: parseFilterSteps(m.filter_steps_json),
    enabled: m.enabled === 1,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

function toApiSink(s: SinkRow) {
  return {
    id: s.id,
    monitorId: s.monitor_id,
    destinationId: s.destination_id,
    filterSteps: parseFilterSteps(s.filter_steps_json),
    createdAt: s.created_at,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toApiJob(j: JobRecord) {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    parentJobId: j.parentJobId,
    error: j.lastError,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
    result: j.result,
    progress: j.uxProgress,
  };
}
