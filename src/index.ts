import { DeploymentInputError, parseDeploymentCreation, parseDeploymentMutation, parseManagedDeployInput } from "./deployment-input";
import { GraphInputError, parseMonitorMutation, parseSinkMutation } from "./graph-input";
import { exchangeSlackWebhook, readSlackOAuthState } from "./destinations/slack-oauth";
import { readProviderOAuthState } from "./providers/oauth-state";
import { createDeploymentIngest } from "./deployment-ingest";
import { deploymentStateRoutes,deploymentAppliedRoutes } from "./deployment-state-routes";
import {managedCleanupRoutes} from "./managed-cleanup-routes";
import { managedRollbackRoutes } from "./managed-rollback-routes";
import { exportDeploymentTarget } from "./deployment-target";
import { createPushReceiptIntent,readPushReceipt,PushReceiptConflict,PushReceiptUnavailable,type PushReceiptIntent } from "./deployment-push-receipts";
import { parseDeploymentPush,resolveOwnedDeploymentManifest,DeploymentPushError } from "./deployment-push";
import { reconcileDeploymentConfiguration } from "./deployment-reconciliation";
import { readDeploymentConfiguration,DeploymentRevisionConflict } from "./deployment-configuration";
import { parseOrderedDeploymentSelection } from "./deployment-selection";
import { ConfigurationConflict, readStableConfiguration } from "./config-version";
import { exportHostedManifest } from "./credential-intent";
import { createSecretVersioner, hashConfigDocument } from "@logtura/core";
import { cliAuthorizationRoutes } from "./cli-auth";
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
  getConnectionByProviderInstallation,
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
  getUserById,
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
  getDestinationConnect,
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
  parseMetricsBody,
} from "./metrics-snapshot";
import {
  JobDriver,
  aggregateStatus,
  isStaleRunningJob,
  staleRunningJobMessage,
} from "./jobs/driver";
import { processQueueBatch } from "./jobs/queue";
import { runSilenceAlerter } from "./silence-alerter";
import {
  type JobRecord,
  lockKeyForDiscovery,
  lockKeyForFlyDeploy,
  type QueueEnvelope,
} from "./jobs/types";
import {
  getProvider,
  getProviderConnect,
  listProviders,
  ProviderError,
} from "./providers";

const app = new Hono<AppContext>();

app.use("/api/deployments/:id/config",async(c,next)=>{c.header("cache-control","no-store");await next();});
app.use("/api/deployments/:id/config/*",async(c,next)=>{c.header("cache-control","no-store");await next();});
app.use("/api/applied/:id",async(c,next)=>{c.header("cache-control","no-store");await next();});
app.use("/api/connections/:id/debug/tail-token",async(c,next)=>{c.header("cache-control","no-store");await next();});
app.use("/api/tail/*",async(c,next)=>{c.header("cache-control","no-store");await next();});
app.use("*", attachOptionalUser);

const deploymentIngest = createDeploymentIngest();

// --- OAuth (server-side redirects) -----------------------------------------

app.get("/login/github", startGithubLogin);
app.get("/auth/github/callback", finishGithubLogin);
app.get("/logout", logout);

// --- JSON API --------------------------------------------------------------

const api = new Hono<AppContext>();
api.route("/cli", cliAuthorizationRoutes());

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
  const providers = listProviders().map((p) => {
    // Pair each OSS driver with its SaaS-side connect adapter so the
    // UI gets form/OAuth metadata alongside the driver identity.
    const connect = getProviderConnect(p.id);
    const connectFlow = connect?.connectFlow ?? null;
    const formFields = connect?.formFields ?? [];
    // OAuth shortcuts live alongside PAT paste flows when a SaaS-managed
    // OAuth app is configured for that provider.
    const oauthShortcut =
      p.id === "supabase-edge-logs" && isSupabaseOauthConfigured(c.env)
        ? {
            startPath: "/api/providers/supabase-edge-logs/start",
            buttonLabel: "Connect Supabase",
            buttonDescription:
              "Sign in to Supabase and grant Logtura read access to your projects' edge functions and analytics.",
          }
        : p.id === "railway-logs" && isRailwayOauthConfigured(c.env)
          ? {
              startPath: "/api/providers/railway/start",
              buttonLabel: "Connect Railway",
              buttonDescription:
                "Sign in to Railway and grant Logtura read access to the projects whose service logs you want to tail.",
            }
        : null;
    return {
      id: p.id,
      displayName: p.displayName,
      sourceLabel: p.sourceLabel,
      capabilities: p.capabilities,
      connectFlow,
      formFields,
      oauthShortcut,
    };
  });
  return c.json({ providers });
});

// Tail-token endpoint: the deployed logtura-http-client binary
// authenticates with the Authorization header carrying a connection-
// scoped JWT (minted by `mintTailToken`). It exchanges that for a
// fresh Supabase access_token, which it then uses to hit Supabase's
// analytics endpoint. Rotation + storage of the refresh_token happens
// inside `ensureFreshAccessToken`, transparent to the binary.
api.post("/tail/supabase/token", async (c) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : null;
  if (!token) return c.json({ error: "missing_authorization" }, 401);
  const { verifyTailToken, tailTokenCacheSeconds } = await import("./providers/tail-token");
  const payload = await verifyTailToken(token, c.env.SESSION_SECRET);
  if (!payload) return c.json({ error: "invalid_token" }, 401);
  const conn = await getConnection(c.env.DB, payload.userId, payload.connectionId);
  if (!conn) return c.json({ error: "connection_not_found" }, 404);
  if (conn.provider !== "supabase-edge-logs") {
    return c.json({ error: "wrong_provider" }, 400);
  }
  try {
    const { ensureFreshAccessToken } = await import("./providers/supabase-token");
    const accessToken = await ensureFreshAccessToken(c.env, conn);
    // Preserve the legacy ceiling, bounded by the provider's actual expiry.
    // Re-read after renewal and reject a concurrently replaced credential.
    const current = await getConnection(c.env.DB, conn.user_id, conn.id);
    if (!current || current.provider !== conn.provider) throw new Error("Connection changed during token request");
    const credentials = await decryptConnectionCredentials<{pat?: string; expiresAt?: number}>(c.env, current);
    if (typeof accessToken !== "string" || !accessToken || credentials.pat !== accessToken) throw new Error("Credentials changed during token request");
    return c.json({ access_token: accessToken, expires_in: tailTokenCacheSeconds(23 * 3600, credentials.expiresAt) });
  } catch (err) {
    console.error("supabase tail token refresh failed", {connectionId: conn.id});
    return c.json(
      {
        error: "refresh_failed",
        message: "could not refresh token",
      },
      503,
    );
  }
});

api.post("/tail/railway/token", async (c) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : null;
  if (!token) return c.json({ error: "missing_authorization" }, 401);
  const { verifyTailToken, tailTokenCacheSeconds } = await import("./providers/tail-token");
  const payload = await verifyTailToken(token, c.env.SESSION_SECRET);
  if (!payload) return c.json({ error: "invalid_token" }, 401);
  const conn = await getConnection(c.env.DB, payload.userId, payload.connectionId);
  if (!conn) return c.json({ error: "connection_not_found" }, 404);
  if (conn.provider !== "railway-logs") {
    return c.json({ error: "wrong_provider" }, 400);
  }
  try {
    const { ensureFreshRailwayAccessToken } = await import(
      "./providers/railway-token"
    );
    const accessToken = await ensureFreshRailwayAccessToken(c.env, conn);
    const current = await getConnection(c.env.DB, conn.user_id, conn.id);
    if (!current || current.provider !== conn.provider) throw new Error("Connection changed during token request");
    const credentials = await decryptConnectionCredentials<{apiToken?: string; expiresAt?: number}>(c.env, current);
    if (typeof accessToken !== "string" || !accessToken || credentials.apiToken !== accessToken) throw new Error("Credentials changed during token request");
    return c.json({ access_token: accessToken, expires_in: tailTokenCacheSeconds(55 * 60, credentials.expiresAt) });
  } catch (err) {
    console.error("railway tail token refresh failed", {connectionId: conn.id});
    return c.json(
      {
        error: "refresh_failed",
        message: "could not refresh token",
      },
      503,
    );
  }
});

const apiAuth = new Hono<AppContext>();
apiAuth.use("/deployments/:id/config",async(c,next)=>{c.header("cache-control","no-store");if(!c.get("user"))return c.json({error:"auth_required"},401);await next();});
apiAuth.use("/deployments/:id/config/*",async(c,next)=>{c.header("cache-control","no-store");if(!c.get("user"))return c.json({error:"auth_required"},401);await next();});
apiAuth.use("*", requireAuth);
apiAuth.route("/",deploymentStateRoutes());
apiAuth.route("/",managedRollbackRoutes(async(driver,job)=>toApiJob((await aggregateJobWithKids(driver,job)).job)));
apiAuth.route("/",managedCleanupRoutes(async(driver,job)=>toApiJob((await aggregateJobWithKids(driver,job)).job)));

apiAuth.get("/connections", async (c) => {
  const user = c.get("user")!;
  const rows = await listConnections(c.env.DB, user.id);
  return c.json({ connections: rows.map(toApiConnection) });
});

apiAuth.get("/connections/by-provider-installation", async (c) => {
  const user = c.get("user")!;
  const provider = c.req.query("provider")?.trim() || "";
  const providerInstallationId =
    c.req.query("provider_installation_id")?.trim() || "";
  if (!provider || !providerInstallationId) {
    return c.json({ connection: null });
  }
  const connection = await getConnectionByProviderInstallation(
    c.env.DB,
    user.id,
    provider,
    providerInstallationId,
  );
  return c.json({ connection: connection ? toApiConnection(connection) : null });
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
  const connect = getProviderConnect(providerId);
  if (!connect) return c.json({ error: "no_connect_adapter" }, 500);

  let credentials: unknown;
  let explicitAccountId: string | null;
  try {
    const parsed = connect.parseFormData(form);
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

  let accountId: string | null = explicitAccountId;
  // Supabase leaves external_account_id null for its post-connect
  // project picker. Railway also stays null because its discovery is
  // token-wide and source-level project/environment/service choices
  // happen later in deployment selection.
  const deferAccountPick =
    !accountId &&
    (driver.id === "supabase-edge-logs" || driver.id === "railway-logs");
  if (!accountId && !deferAccountPick) {
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

  // Supabase defers discovery until the user picks a project ref.
  // Other providers can discover with either an explicit account id
  // or a personal-account token. Railway discovers project/environment
  // service sources directly from the token.
  if (accountId || driver.id !== "supabase-edge-logs") {
    const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
    await jobs.enqueue({
      userId: user.id,
      kind: "discovery",
      payload: { connectionId: connection.id },
      lockKey: lockKeyForDiscovery(connection.id),
    });
  }

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

// Debug surface: mint a tail JWT for a connection so an operator
// can curl /api/tail/supabase/token end-to-end without spinning up
// a Fly deployment. Owner-gated; the JWT is identical to the one
// the user's deployment env already carries, so no new privilege
// surface beyond the connection's existing owner.
//
// We keep this around — production endpoints (Supabase/CF/Fly)
// are read-only and harmless to hit, and smoke surfaces catch
// bugs unit tests miss. See memory:
// feedback_production_endpoints_are_fair_game.md.
apiAuth.post("/connections/:id/debug/tail-token", async (c) => {
  const user = c.get("user")!;
  const conn = await getConnection(c.env.DB, user.id, c.req.param("id"));
  if (!conn) return c.json({ error: "not_found" }, 404);
  if (!["supabase-edge-logs", "railway-logs"].includes(conn.provider)) return c.json({error:"wrong_provider"},400);
  const { mintTailToken } = await import("./providers/tail-token");
  const token = await mintTailToken(
    { connectionId: conn.id, userId: user.id },
    c.env.SESSION_SECRET,
  );
  return c.json({
    tailToken: token,
    tailTokenUrl: `${c.env.APP_URL}/api/tail/${conn.provider === "railway-logs" ? "railway" : "supabase"}/token`,
  });
});

// Supabase project picker: lists projects visible to the stored
// credential along with each project's edge-function count. The UI
// shows this when a supabase connection has no external_account_id
// yet (post-OAuth or post-PAT-paste-without-project-ref). Refreshes
// the OAuth access_token transparently if expired.
apiAuth.get("/connections/:id/supabase-projects", async (c) => {
  const user = c.get("user")!;
  const conn = await getConnection(c.env.DB, user.id, c.req.param("id"));
  if (!conn) return c.json({ error: "not_found" }, 404);
  if (conn.provider !== "supabase-edge-logs") {
    return c.json({ error: "wrong_provider" }, 400);
  }
  let token: string;
  try {
    const { ensureFreshAccessToken } = await import(
      "./providers/supabase-token"
    );
    token = await ensureFreshAccessToken(c.env, conn);
  } catch (err) {
    console.error("supabase token refresh failed");
    return c.json(
      {
        error: "token_refresh_failed",
        message:
          "Stored Supabase token is no longer valid. Reconnect this connection.",
      },
      400,
    );
  }
  try {
    const projRes = await fetch("https://api.supabase.com/v1/projects", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!projRes.ok) {
      return c.json(
        { error: "list_failed", message: `HTTP ${projRes.status}` },
        400,
      );
    }
    const projects = (await projRes.json()) as Array<{
      ref: string;
      name: string;
      organization_id?: string;
    }>;
    if (!Array.isArray(projects) || projects.some(p => !p || typeof p.ref !== "string" || !p.ref || typeof p.name !== "string")) throw new Error("Invalid Supabase project list");
    const enriched = await Promise.all(
      projects.map(async (p) => {
        const fnRes = await fetch(
          `https://api.supabase.com/v1/projects/${p.ref}/functions`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json",
            },
          },
        );
        let functionCount: number | null = null;
        if (fnRes.ok) {
          try {
            const arr = (await fnRes.json()) as unknown[];
            functionCount = Array.isArray(arr) ? arr.length : null;
          } catch {
            functionCount = null;
          }
        }
        return {
          ref: p.ref,
          name: p.name,
          organizationId: p.organization_id ?? null,
          functionCount,
        };
      }),
    );
    return c.json({ projects: enriched });
  } catch {
    console.error("supabase project list failed");
    return c.json({error:"list_failed",message:"Failed to list Supabase projects"},400);
  }
});

apiAuth.post("/connections/:id/supabase-pick-project", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const conn = await getConnection(c.env.DB, user.id, id);
  if (!conn) return c.json({ error: "not_found" }, 404);
  if (conn.provider !== "supabase-edge-logs") {
    return c.json({ error: "wrong_provider" }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectRef?: string;
  } | null;
  const projectRef = typeof body?.projectRef === "string" ? body.projectRef.trim() : "";
  if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef)) {
    return c.json({ error: "invalid_project_ref" }, 400);
  }
  // Re-use updateConnectionCredentials to bump external_account_id;
  // we don't actually re-write the credentials blob (pass through).
  const creds = await decryptConnectionCredentials(c.env, conn);
  const updated = await updateConnectionCredentials(
    c.env.DB,
    c.env,
    user.id,
    id,
    {
      credentials: creds,
      expectedProvider: conn.provider,
      expectedConnection: conn,
      externalAccountId: projectRef,
    },
  );
  if (!updated) return c.json({ error: "not_found" }, 404);
  const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  await jobs.enqueue({
    userId: user.id,
    kind: "discovery",
    payload: { connectionId: id },
    lockKey: lockKeyForDiscovery(id),
  });
  return c.json({ connection: toApiConnection(updated) });
});

apiAuth.get("/connections/:id/railway-environments", async (c) => {
  const user = c.get("user")!;
  const conn = await getConnection(c.env.DB, user.id, c.req.param("id"));
  if (!conn) return c.json({ error: "not_found" }, 404);
  if (conn.provider !== "railway-logs") {
    return c.json({ error: "wrong_provider" }, 400);
  }
  let token: string;
  try {
    const { ensureFreshRailwayAccessToken } = await import(
      "./providers/railway-token"
    );
    token = await ensureFreshRailwayAccessToken(c.env, conn);
  } catch (err) {
    console.error("railway token refresh failed");
    return c.json(
      {
        error: "token_refresh_failed",
        message:
          "Stored Railway token is no longer valid. Reconnect this connection.",
      },
      400,
    );
  }

  try {
    const projects = await listRailwayProjectsWithEnvironments(token);
    return c.json({ projects });
  } catch (err) {
    console.error("railway environment list failed");
    return c.json(
      {
        error: "list_failed",
        message:
          "Failed to list Railway environments",
      },
      400,
    );
  }
});

apiAuth.post("/connections/:id/railway-pick-environment", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const conn = await getConnection(c.env.DB, user.id, id);
  if (!conn) return c.json({ error: "not_found" }, 404);
  if (conn.provider !== "railway-logs") {
    return c.json({ error: "wrong_provider" }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: string;
    environmentId?: string;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  const environmentId = typeof body?.environmentId === "string" ? body.environmentId.trim() : "";
  if (!isRailwayId(projectId) || !isRailwayId(environmentId)) {
    return c.json({ error: "invalid_railway_environment" }, 400);
  }
  const creds = await decryptConnectionCredentials<Record<string, unknown>>(
    c.env,
    conn,
  );
  const updated = await updateConnectionCredentials(
    c.env.DB,
    c.env,
    user.id,
    id,
    {
      expectedProvider: conn.provider,
      expectedConnection: conn,
      credentials: {
        ...creds,
        projectId,
        environmentId,
      },
      externalAccountId: `${projectId}:${environmentId}`,
    },
  );
  if (!updated) return c.json({ error: "not_found" }, 404);
  const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  await jobs.enqueue({
    userId: user.id,
    kind: "discovery",
    payload: { connectionId: id },
    lockKey: lockKeyForDiscovery(id),
  });
  return c.json({ connection: toApiConnection(updated) });
});

async function listRailwayProjectsWithEnvironments(token: string): Promise<
  Array<{
    id: string;
    name: string;
    environments: Array<{
      id: string;
      name: string;
      serviceCount: number | null;
    }>;
  }>
> {
  const { railwayGraphql } = await import("@logtura/driver-railway-logs");
  const scoped = await railwayGraphql<{
    externalWorkspaces?: Array<{
      projects?: Array<{ id?: string; name?: string }>;
    }>;
  }>(
    token,
    `query ExternalProjects {
      externalWorkspaces {
        projects { id name }
      }
    }`,
    {},
  ).catch(() => null);
  const scopedProjects = (scoped?.externalWorkspaces ?? [])
    .flatMap((workspace) => workspace.projects ?? [])
    .filter((project): project is { id: string; name?: string } =>
      Boolean(project?.id),
    );

  const accountProjects =
    scopedProjects.length > 0
      ? scopedProjects
      : await railwayGraphql<{
          projects?: {
            edges?: Array<{ node?: { id?: string; name?: string } }>;
          };
        }>(
          token,
          `query Projects {
            projects { edges { node { id name } } }
          }`,
          {},
        ).then((data) =>
          (data.projects?.edges ?? [])
            .map((edge) => edge.node)
            .filter((project): project is { id: string; name?: string } =>
              Boolean(project?.id),
            ),
        );

  return Promise.all(
    accountProjects.map(async (project) => {
      const data = await railwayGraphql<{
        project?: {
          environments?: {
            edges?: Array<{
              node?: {
                id?: string;
                name?: string;
                serviceInstances?: { edges?: unknown[] };
              };
            }>;
          };
        };
      }>(
        token,
        `query ProjectEnvironments($projectId: String!) {
          project(id: $projectId) {
            environments {
              edges {
                node {
                  id
                  name
                  serviceInstances(first: 200) {
                    edges { node { serviceId } }
                  }
                }
              }
            }
          }
        }`,
        { projectId: project.id },
      );
      const environments = (data.project?.environments?.edges ?? [])
        .map((edge) => edge.node)
        .filter((env): env is {
          id: string;
          name?: string;
          serviceInstances?: { edges?: unknown[] };
        } => Boolean(env?.id))
        .map((env) => ({
          id: env.id,
          name: env.name ?? env.id,
          serviceCount: Array.isArray(env.serviceInstances?.edges)
            ? env.serviceInstances!.edges!.length
            : null,
        }));
      return {
        id: project.id,
        name: project.name ?? project.id,
        environments,
      };
    }),
  );
}

function isRailwayId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

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
  const connect = getProviderConnect(existing.provider);
  if (!connect) return c.json({ error: "no_connect_adapter" }, 500);

  const form = await c.req.formData();
  let credentials: unknown;
  let explicitAccountId: string | null;
  try {
    const parsed = connect.parseFormData(form);
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

  // Prefer the explicit account id from the form; otherwise keep
  // the existing ref if the new token can still see it (the common
  // "I rotated my token, same project" case). If the existing ref
  // isn't visible to the new token, clear it so the picker fires
  // again — better than letting discovery 404 against a project
  // the new token can't reach.
  let accountId: string | null = explicitAccountId;
  if (!accountId && existing.external_account_id) {
    const stillVisible = accounts.some(
      (a) => a.id === existing.external_account_id,
    );
    accountId = stillVisible ? existing.external_account_id : null;
  }
  // Auto-pick a first account ONLY for providers that don't have a
  // post-connect picker or token-wide discovery. Supabase defers to
  // picker UI; Railway discovers source-level project/environment choices.
  if (
    !accountId &&
    driver.id !== "supabase-edge-logs" &&
    driver.id !== "railway-logs" &&
    accounts.length > 0
  ) {
    accountId = accounts[0]!.id;
  }

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

// Portable graph export. Secret payloads are returned only by explicit request.
// Revisions describe the current graph; desired/applied tracking is a separate layer.
apiAuth.get("/deployments/:id/config", async (c) => {
  c.header("cache-control", "no-store");
  const user = c.get("user")!;
  const id = c.req.param("id");
  if (!await getDeployment(c.env.DB, user.id, id)) return c.json({error:"not_found"},404);
  try {
    const snapshot=await readStableConfiguration(c.env.DB,user.id,async()=>{
      const assembled=await assembleDeploymentBundle(c.env,user.id,id);
      const exported=await exportHostedManifest(assembled.input,assembled.credentialVersions,await createSecretVersioner(c.env.CREDENTIAL_ENCRYPTION_KEY));
      return {document:exported.document,revision:await hashConfigDocument(exported.document),desiredSequence:(await readDeploymentConfiguration(c.env.DB,user.id,id))?.desired.sequence??0,
        deployment:{id:assembled.deployment.id,displayName:assembled.deployment.display_name},target:exportDeploymentTarget(assembled.deployment),
        ...(c.req.query("includeSecrets")==="1"?{secretValues:exported.secretValues}:{})};
    });
    return c.json({...snapshot.value,configurationVersion:snapshot.version});
  }catch(error){
    if(error instanceof ConfigurationConflict)return c.json({error:"configuration_changed",configurationVersion:error.currentVersion},409);
    if(error instanceof Error && ["deployment not found","connection not found","Configuration owner not found"].some(message=>error.message.includes(message)))return c.json({error:"not_found"},404);
    throw error;
  }
});

apiAuth.get("/deployments/:id/config/receipts/:requestId",async c=>{
  const user=c.get("user")!,id=c.req.param("id");
  try{
    if(!await getDeployment(c.env.DB,user.id,id))return c.json({error:"not_found"},404);
    const receipt=await readPushReceipt(c.env.DB,user.id,id,c.req.param("requestId"));
    return receipt?c.json(receipt):c.json({error:"receipt_not_found"},404);
  }catch(error){if(error instanceof DeploymentPushError)return c.json({error:error.code},error.status);return c.json({error:"configuration_unavailable"},503);}
});

apiAuth.put("/deployments/:id/config",async c=>{
  c.header("cache-control","no-store");
  const user=c.get("user")!,id=c.req.param("id");
  try{if(!await getDeployment(c.env.DB,user.id,id))return c.json({error:"not_found"},404);}catch{return c.json({error:"configuration_unavailable"},503);}
  // Bound streamed bodies too; a missing or dishonest Content-Length cannot
  // cause an unbounded allocation before JSON validation.
  const reader=c.req.raw.body?.getReader();if(!reader)return c.json({error:"invalid_push"},400);
  const chunks:Uint8Array[]=[];let length=0;
  try{
    while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>1_048_576){await reader.cancel();return c.json({error:"push_too_large"},413);}chunks.push(part.value);}
  }catch{return c.json({error:"invalid_push"},400);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let receipt:PushReceiptIntent|undefined;
  try{
    let value:unknown;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{return c.json({error:"invalid_push"},400);}
    const body=parseDeploymentPush(value);
    receipt=await createPushReceiptIntent(c.env,user.id,id,body);
    if(receipt){const prior=await readPushReceipt(c.env.DB,user.id,id,receipt.requestId,receipt.requestHash);if(prior)return c.json(prior.result);}
    const resolved=await resolveOwnedDeploymentManifest(c.env,user.id,id,body);
    const result=await reconcileDeploymentConfiguration(c.env,user.id,id,body.expectedConfigurationVersion,body.expectedSequence,resolved.input,await createSecretVersioner(c.env.CREDENTIAL_ENCRYPTION_KEY),resolved.retainedCredentials,receipt);
    return c.json(result);
  }catch(error){
    // Another identical writer may have committed while this request was being
    // prepared. Durable receipts take precedence over stale-fence/unique errors.
    if(receipt && !(error instanceof PushReceiptConflict) && !(error instanceof PushReceiptUnavailable)){
      try{const prior=await readPushReceipt(c.env.DB,user.id,id,receipt.requestId,receipt.requestHash);if(prior)return c.json(prior.result);}
      catch(recoveryError){error=recoveryError;}
    }
    if(error instanceof PushReceiptConflict)return c.json({error:"request_id_reused"},409);
    if(error instanceof PushReceiptUnavailable)return c.json({error:"configuration_unavailable"},503);
    if(error instanceof DeploymentPushError)return c.json({error:error.code},error.status);
    if(error instanceof ConfigurationConflict)return c.json({error:"configuration_changed",configurationVersion:error.currentVersion},409);
    if(error instanceof DeploymentRevisionConflict)return c.json({error:"desired_changed"},409);
    if(error instanceof Error && /constraint failed/i.test(error.message))return c.json({error:"identity_conflict"},409);
    if(!(error instanceof Error) || /D1_ERROR|D1_EXEC_ERROR/.test(error.message))return c.json({error:"configuration_unavailable"},503);
    return c.json({error:"invalid_configuration"},400);
  }
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
  let body;
  try {body=parseDeploymentCreation(await c.req.json());}
  catch(error){return c.json({error:error instanceof DeploymentInputError ? error.code : "invalid_form"},400);}
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
  if(deployment.graph_selection_json && !parseOrderedDeploymentSelection(JSON.parse(deployment.graph_selection_json)).legacySources){
    derivedConnIds=parseOrderedDeploymentSelection(JSON.parse(deployment.graph_selection_json)).connections.map(c=>c.id);
  }else if (selection.sourceIds && selection.sourceIds.length > 0) {
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
    connections: derivedConnIds.flatMap(id=>conns.filter(c=>c.id===id)).map((cc) => ({
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
  if(!await getDeployment(c.env.DB,user.id,id)) return c.json({error:"not_found"},404);
  let body;
  try {body=parseDeploymentMutation(await c.req.json());}
  catch(error){return c.json({error:error instanceof DeploymentInputError ? error.code : "invalid_form"},400);}
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
  const updated = await updateDeployment(c.env.DB, user.id, id, body);
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

  let body;
  try {body=parseManagedDeployInput(await c.req.json());}
  catch(error){return c.json({error:error instanceof DeploymentInputError ? error.code : "invalid_form"},400);}
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

  if(!getDeployTargetDriver(target.kind)?.supportsManaged) return c.json({error:"managed_deploy_unsupported"},400);
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

  const now = Date.now();
  const result = await deploymentIngest.ingest(c.env.DB, id, presented, [], now);
  if (result === "not_found") return c.json({ error: result }, 404);
  if (result === "invalid_token") return c.json({ error: result }, 401);
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
  const now = Date.now();
  const authorized = await deploymentIngest.authenticate(c.env.DB, id, presented, now);
  if (authorized === "not_found") return c.json({ error: authorized }, 404);
  if (authorized === "invalid_token") return c.json({ error: authorized }, 401);
  let body = "";
  try {
    body = await c.req.text();
  } catch {
    // empty body — still record liveness below
  }
  const result = await deploymentIngest.ingest(c.env.DB, id, presented, parseMetricsBody(body), now);
  if (result === "not_found") return c.json({ error: result }, 404);
  if (result === "invalid_token") return c.json({ error: result }, 401);
  // D1 failures remain retryable; successful/coalesced observations are acknowledged.
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
  const drivers = listDestinationDrivers().map((d) => {
    const connect = getDestinationConnect(d.id);
    return {
      id: d.id,
      displayName: d.displayName,
      description: d.description,
      connectFlow: connect?.connectFlow ?? null,
      formFields: connect?.formFields ?? [],
    };
  });
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
  const connect = getDestinationConnect(kind);
  if (!connect) return c.json({ error: "no_connect_adapter" }, 500);
  let parsed;
  try {
    parsed = connect.parseFormData(form);
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

// ---------- Vercel OAuth (platform = "vercel", driver = "vercel-logs") ----

const VERCEL_STATE_COOKIE = "logtura_vercel_state";
const VERCEL_LOGS_PROVIDER = "vercel-logs";
const DEFAULT_VERCEL_INTEGRATION_SLUG = "logtura";

function isVercelOauthConfigured(env: Env): boolean {
  return !!(env.VERCEL_CLIENT_ID && env.VERCEL_CLIENT_SECRET);
}

api.get("/providers/vercel/start", async (c) => {
  const userId = c.get("authKind") === "session" ? c.get("user")?.id : null;
  if (!userId) return c.redirect("/?error=auth_required", 303);
  if (!isVercelOauthConfigured(c.env)) {
    return c.redirect("/app/connections/new?error=vercel_oauth_not_configured", 303);
  }

  const reconnectId = c.req.query("reconnect_id")?.trim() || null;
  let displayName = c.req.query("display_name")?.trim();
  if (reconnectId) {
    const existing = await getConnection(c.env.DB, userId, reconnectId);
    if (!existing || existing.provider !== VERCEL_LOGS_PROVIDER) {
      return c.redirect("/app?error=bad_reconnect", 303);
    }
    displayName = displayName || existing.display_name;
  }
  if (!displayName) {
    return c.redirect("/app/connections/new?error=missing_display_name", 303);
  }

  const state = newToken();
  const { buildVercelInstallUrl } = await import("./providers/vercel-oauth");
  const signed = await signCookie(
    JSON.stringify({ state, userId, displayName, reconnectId }),
    c.env.SESSION_SECRET,
  );
  setCookie(c, VERCEL_STATE_COOKIE, signed, {
    httpOnly: true,
    secure: c.env.APP_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  return c.redirect(
    buildVercelInstallUrl({
      slug: c.env.VERCEL_INTEGRATION_SLUG ?? DEFAULT_VERCEL_INTEGRATION_SLUG,
      state,
    }),
    303,
  );
});

api.get("/providers/vercel/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const configurationId = c.req.query("configurationId")?.trim() || null;
  const next = c.req.query("next")?.trim() || null;
  const stateCookie = getCookie(c, VERCEL_STATE_COOKIE);
  const stateJson = await verifyCookie(stateCookie, c.env.SESSION_SECRET);
  deleteCookie(c, VERCEL_STATE_COOKIE, { path: "/" });
  if (!code) {
    return c.redirect("/app/connections/new?error=vercel_oauth_state", 303);
  }
  const parsed = (() => {
    if (!stateJson) return null;
    try {
      return JSON.parse(stateJson) as {
        state?: string;
        userId?: string;
        displayName?: string;
        reconnectId?: string | null;
      };
    } catch {
      return null;
    }
  })();
  const sessionUserId = c.get("authKind") === "session" ? c.get("user")?.id : null;
  const callbackCtx =
    parsed && state && parsed.state === state && parsed.userId && parsed.displayName
      ? {
          userId: parsed.userId,
          displayName: parsed.displayName,
          reconnectId: parsed.reconnectId ?? null,
        }
      : sessionUserId
        ? {
            userId: sessionUserId,
            displayName: "Vercel",
            reconnectId: null,
          }
        : null;
  if (!callbackCtx) {
    return c.redirect("/?error=auth_required", 303);
  }
  if (callbackCtx.reconnectId) {
    const existing = await getConnection(c.env.DB, callbackCtx.userId, callbackCtx.reconnectId);
    if (!existing || existing.provider !== VERCEL_LOGS_PROVIDER) return c.redirect("/app?error=bad_reconnect", 303);
  }
  if (!isVercelOauthConfigured(c.env)) {
    return c.redirect("/app/connections/new?error=vercel_oauth_not_configured", 303);
  }

  const { exchangeVercelCode, vercelCredentialsFromOAuth } = await import(
    "./providers/vercel-oauth"
  );
  let tokens;
  try {
    tokens = await exchangeVercelCode({
      clientId: c.env.VERCEL_CLIENT_ID!,
      clientSecret: c.env.VERCEL_CLIENT_SECRET!,
      code,
      redirectUri: `${c.env.APP_URL}/api/providers/vercel/callback`,
    });
  } catch (err) {
    console.error("vercel oauth exchange failed", err);
    return c.redirect("/app/connections/new?error=vercel_oauth_exchange", 303);
  }

  const driver = getProvider(VERCEL_LOGS_PROVIDER);
  if (!driver) {
    return c.redirect("/app/connections/new?error=unknown_provider", 303);
  }
  const credentials = vercelCredentialsFromOAuth(tokens);
  let accounts: { id: string; name: string }[];
  try {
    accounts = await driver.verifyCredentials(credentials);
  } catch (err) {
    console.error("vercel oauth verify failed", {
      status: err instanceof ProviderError ? err.status : undefined,
      configurationId,
      teamId: tokens.team_id ?? null,
      userId: tokens.user_id ?? null,
      installationId: tokens.installation_id ?? null,
    });
    return c.redirect("/app/connections/new?error=vercel_oauth_verify", 303);
  }

  const externalAccountId = tokens.team_id ?? null;
  const displayName =
    callbackCtx.displayName === "Vercel" && accounts[0]?.name
      ? `Vercel · ${accounts[0].name}`
      : callbackCtx.displayName;
  let connectionId: string;
  if (callbackCtx.reconnectId) {
    const updated = await updateConnectionCredentials(
      c.env.DB,
      c.env,
      callbackCtx.userId,
      callbackCtx.reconnectId,
      {
        credentials,
        expectedProvider: VERCEL_LOGS_PROVIDER,
        externalAccountId,
        providerInstallationId: tokens.installation_id ?? configurationId,
        displayName,
      },
    );
    if (!updated) return c.redirect("/app?error=bad_reconnect", 303);
    connectionId = updated.id;
  } else {
    const connection = await createConnection(c.env.DB, c.env, {
      userId: callbackCtx.userId,
      provider: driver.id,
      displayName,
      externalAccountId,
      providerInstallationId: tokens.installation_id ?? configurationId,
      credentials,
    });
    connectionId = connection.id;
    await ensureDefaultErrorsMonitor(c.env.DB, callbackCtx.userId);
  }

  const jobs = new JobDriver(c.env.DB, c.env.JOBS_QUEUE);
  await jobs.enqueue({
    userId: callbackCtx.userId,
    kind: "discovery",
    payload: { connectionId },
    lockKey: lockKeyForDiscovery(connectionId),
  });
  if (next) {
    try {
      const nextUrl = new URL(next);
      if (nextUrl.protocol === "https:" && nextUrl.hostname === "vercel.com") {
        return c.redirect(nextUrl.toString(), 303);
      }
    } catch {
      // Ignore malformed completion URLs and fall back to the connection page.
    }
  }
  return c.redirect(`/app/connections/${connectionId}`, 303);
});

// ---------- Railway OAuth (provider = "railway-logs") -------------------

const RAILWAY_STATE_COOKIE = "logtura_railway_state";
const RAILWAY_LOGS_PROVIDER = "railway-logs";

function isRailwayOauthConfigured(env: Env): boolean {
  return !!(env.RAILWAY_CLIENT_ID && env.RAILWAY_CLIENT_SECRET);
}

api.get("/providers/railway/start", async (c) => {
  const userId = c.get("authKind") === "session" ? c.get("user")?.id : null;
  if (!userId) return c.redirect("/?error=auth_required", 303);
  if (!isRailwayOauthConfigured(c.env)) {
    return c.redirect(
      "/app/connections/new?error=railway_oauth_not_configured",
      303,
    );
  }

  const reconnectId = c.req.query("reconnect_id")?.trim() || null;
  let displayName = c.req.query("display_name")?.trim();
  if (reconnectId) {
    const existing = await getConnection(c.env.DB, userId, reconnectId);
    if (!existing || existing.provider !== RAILWAY_LOGS_PROVIDER) {
      return c.redirect("/app?error=bad_reconnect", 303);
    }
    displayName = displayName || existing.display_name;
  }
  if (!displayName) {
    return c.redirect("/app/connections/new?error=missing_display_name", 303);
  }

  const {
    buildRailwayAuthorizeUrl,
    generateRailwayPkcePair,
  } = await import("./providers/railway-oauth");
  const state = newToken();
  const { verifier, challenge } = await generateRailwayPkcePair();
  const signed = await signCookie(
    JSON.stringify({ state, userId, displayName, verifier, reconnectId }),
    c.env.SESSION_SECRET,
  );
  setCookie(c, RAILWAY_STATE_COOKIE, signed, {
    httpOnly: true,
    secure: c.env.APP_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  return c.redirect(
    buildRailwayAuthorizeUrl({
      clientId: c.env.RAILWAY_CLIENT_ID!,
      redirectUri: `${c.env.APP_URL}/api/providers/railway/callback`,
      state,
      codeChallenge: challenge,
    }),
    303,
  );
});

api.get("/providers/railway/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const stateCookie = getCookie(c, RAILWAY_STATE_COOKIE);
  const stateJson = await verifyCookie(stateCookie, c.env.SESSION_SECRET);
  deleteCookie(c, RAILWAY_STATE_COOKIE, { path: "/" });
  if (!code || !state || !stateJson) {
    return c.redirect("/app/connections/new?error=railway_oauth_state", 303);
  }
  const parsed = readProviderOAuthState(stateJson, state);
  if (!parsed) return c.redirect("/app/connections/new?error=railway_oauth_state", 303);
  if (parsed.reconnectId) {
    const existing = await getConnection(c.env.DB, parsed.userId, parsed.reconnectId);
    if (!existing || existing.provider !== RAILWAY_LOGS_PROVIDER) return c.redirect("/app?error=bad_reconnect", 303);
  }
  if (!isRailwayOauthConfigured(c.env)) {
    return c.redirect(
      "/app/connections/new?error=railway_oauth_not_configured",
      303,
    );
  }

  const {
    exchangeRailwayCode,
    railwayCredentialsFromOAuth,
  } = await import("./providers/railway-oauth");
  let tokens;
  try {
    tokens = await exchangeRailwayCode({
      clientId: c.env.RAILWAY_CLIENT_ID!,
      clientSecret: c.env.RAILWAY_CLIENT_SECRET!,
      code,
      redirectUri: `${c.env.APP_URL}/api/providers/railway/callback`,
      codeVerifier: parsed.verifier,
    });
  } catch (err) {
    console.error("railway oauth exchange failed", err);
    return c.redirect(
      "/app/connections/new?error=railway_oauth_exchange",
      303,
    );
  }

  const driver = getProvider(RAILWAY_LOGS_PROVIDER);
  if (!driver) {
    return c.redirect("/app/connections/new?error=unknown_provider", 303);
  }
  const credentials = railwayCredentialsFromOAuth(tokens);
  try {
    await driver.verifyCredentials(credentials);
  } catch (err) {
    console.error("railway oauth verify failed", {status: err instanceof ProviderError ? err.status : undefined});
    return c.redirect("/app/connections/new?error=railway_oauth_verify", 303);
  }

  if (parsed.reconnectId) {
    const updated = await updateConnectionCredentials(
      c.env.DB,
      c.env,
      parsed.userId,
      parsed.reconnectId,
      { credentials, externalAccountId: null, expectedProvider: RAILWAY_LOGS_PROVIDER },
    );
    if (!updated) return c.redirect("/app?error=bad_reconnect", 303);
    return c.redirect(`/app/connections/${updated.id}`, 303);
  }

  const connection = await createConnection(c.env.DB, c.env, {
    userId: parsed.userId,
    provider: driver.id,
    displayName: parsed.displayName,
    externalAccountId: null,
    credentials,
  });
  await ensureDefaultErrorsMonitor(c.env.DB, parsed.userId);
  return c.redirect(`/app/connections/${connection.id}`, 303);
});

// ---------- Supabase OAuth (provider = "supabase-edge-logs") -------------

const SUPABASE_STATE_COOKIE = "logtura_supabase_state";

function isSupabaseOauthConfigured(env: Env): boolean {
  return !!(env.SUPABASE_CLIENT_ID && env.SUPABASE_CLIENT_SECRET);
}

api.get("/providers/supabase-edge-logs/start", async (c) => {
  const userId = c.get("authKind") === "session" ? c.get("user")?.id : null;
  if (!userId) return c.redirect("/?error=auth_required", 303);

  if (!isSupabaseOauthConfigured(c.env)) {
    return c.redirect(
      "/app/connections/new?error=supabase_oauth_not_configured",
      303,
    );
  }
  const reconnectId = c.req.query("reconnect_id")?.trim() || null;
  let displayName = c.req.query("display_name")?.trim();
  // Reconnect mode: pull displayName from the existing connection so
  // the user doesn't have to retype it.
  if (reconnectId) {
    const existing = await getConnection(c.env.DB, userId, reconnectId);
    if (!existing || existing.provider !== "supabase-edge-logs") {
      return c.redirect("/app?error=bad_reconnect", 303);
    }
    displayName = displayName || existing.display_name;
  }
  if (!displayName) {
    return c.redirect(
      "/app/connections/new?error=missing_display_name",
      303,
    );
  }

  const { generatePkcePair, buildAuthorizeUrl } = await import(
    "./providers/supabase-oauth"
  );
  const state = newToken();
  const { verifier, challenge } = await generatePkcePair();
  const stateBlob = JSON.stringify({
    state,
    userId,
    displayName,
    verifier,
    reconnectId,
  });
  const signed = await signCookie(stateBlob, c.env.SESSION_SECRET);
  setCookie(c, SUPABASE_STATE_COOKIE, signed, {
    httpOnly: true,
    secure: c.env.APP_URL.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const url = buildAuthorizeUrl({
    clientId: c.env.SUPABASE_CLIENT_ID!,
    redirectUri: `${c.env.APP_URL}/api/providers/supabase-edge-logs/callback`,
    state,
    codeChallenge: challenge,
  });
  return c.redirect(url, 303);
});

api.get("/providers/supabase-edge-logs/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const stateCookie = getCookie(c, SUPABASE_STATE_COOKIE);
  const stateJson = await verifyCookie(stateCookie, c.env.SESSION_SECRET);
  deleteCookie(c, SUPABASE_STATE_COOKIE, { path: "/" });
  if (!code || !state || !stateJson) {
    return c.redirect("/app/connections/new?error=oauth_state", 303);
  }
  const parsed = readProviderOAuthState(stateJson, state);
  if (!parsed) return c.redirect("/app/connections/new?error=oauth_state", 303);
  if (parsed.reconnectId) {
    const existing = await getConnection(c.env.DB, parsed.userId, parsed.reconnectId);
    if (!existing || existing.provider !== "supabase-edge-logs") return c.redirect("/app?error=bad_reconnect", 303);
  }
  if (!isSupabaseOauthConfigured(c.env)) {
    return c.redirect(
      "/app/connections/new?error=supabase_oauth_not_configured",
      303,
    );
  }

  const { exchangeCodeForToken } = await import("./providers/supabase-oauth");
  let tokens;
  try {
    tokens = await exchangeCodeForToken({
      clientId: c.env.SUPABASE_CLIENT_ID!,
      clientSecret: c.env.SUPABASE_CLIENT_SECRET!,
      code,
      redirectUri: `${c.env.APP_URL}/api/providers/supabase-edge-logs/callback`,
      codeVerifier: parsed.verifier,
    });
  } catch (err) {
    console.error("supabase oauth exchange failed", err);
    return c.redirect(
      "/app/connections/new?error=supabase_oauth_exchange",
      303,
    );
  }

  const driver = getProvider("supabase-edge-logs");
  if (!driver) {
    return c.redirect("/app/connections/new?error=unknown_provider", 303);
  }
  const credentials = {
    pat: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  // Verify the token works, but DON'T auto-pick a project. With
  // multiple projects per Supabase org, auto-picking has a high
  // chance of grabbing the wrong one. ConnectionDetail's picker
  // takes over once we land back there.
  try {
    await driver.verifyCredentials(credentials);
  } catch (err) {
    console.error("supabase oauth verify failed", {status: err instanceof ProviderError ? err.status : undefined});
    return c.redirect(
      "/app/connections/new?error=supabase_oauth_verify",
      303,
    );
  }

  // Reconnect swaps credentials while preserving the user's project selection.
  // The picker remains available for an explicit project change.
  if (parsed.reconnectId) {
    const updated = await updateConnectionCredentials(
      c.env.DB,
      c.env,
      parsed.userId,
      parsed.reconnectId,
      { credentials, externalAccountId: null, expectedProvider: "supabase-edge-logs" },
    );
    if (!updated) {
      return c.redirect("/app?error=bad_reconnect", 303);
    }
    return c.redirect(`/app/connections/${parsed.reconnectId}`, 303);
  }

  const connection = await createConnection(c.env.DB, c.env, {
    userId: parsed.userId,
    provider: driver.id,
    displayName: parsed.displayName,
    externalAccountId: null,
    credentials,
  });
  await ensureDefaultErrorsMonitor(c.env.DB, parsed.userId);
  // Don't queue discovery yet — no project ref is set. Discovery
  // fires after the user picks a project in ConnectionDetail.

  return c.redirect(`/app/connections/${connection.id}`, 303);
});

// ---------- Slack OAuth (destination kind = "slack") ---------------------

const SLACK_STATE_COOKIE = "logtura_slack_state";

api.get("/destinations/slack/start", async (c) => {
  // Auth required; we set the user-id into the state so the callback
  // (which arrives without our session intentionally — Slack redirects
  // independently of the user's browser session) can reattach to the
  // right user.
  const userId = c.get("authKind") === "session" ? c.get("user")?.id : null;
  if (!userId) return c.redirect("/?error=auth_required", 303);

  if (!c.env.SLACK_CLIENT_ID || !c.env.SLACK_CLIENT_SECRET) {
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
  const parsed = readSlackOAuthState(stateJson, state);
  if (!parsed) return c.redirect("/app/destinations?error=oauth_state", 303);
  if (!await getUserById(c.env.DB, parsed.userId)) return c.redirect("/?error=auth_required", 303);
  if (!c.env.SLACK_CLIENT_ID || !c.env.SLACK_CLIENT_SECRET) {
    return c.redirect(
      "/app/destinations?error=slack_not_configured",
      303,
    );
  }
  let webhook;
  try {
    webhook = await exchangeSlackWebhook({ clientId: c.env.SLACK_CLIENT_ID,
      clientSecret: c.env.SLACK_CLIENT_SECRET, code,
      redirectUri: `${c.env.APP_URL}/api/destinations/slack/callback` });
  } catch {
    console.error("slack oauth exchange failed");
    return c.redirect("/app/destinations?error=slack_exchange", 303);
  }
  await createDestination(c.env.DB, c.env, {
    userId: parsed.userId,
    kind: "slack",
    displayName: webhook.displayName,
    config: webhook.config,
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
  let body;
  try { body = parseMonitorMutation(await c.req.json(), true); }
  catch (error) { return c.json({ error: error instanceof GraphInputError ? error.code : "invalid_form" }, 400); }
  if (body.connectionId && !await getConnection(c.env.DB, user.id, body.connectionId)) return c.json({ error: "connection_not_found" }, 404);
  const monitor = await createMonitor(c.env.DB, {
    userId: user.id, connectionId: body.connectionId ?? null,
    displayName: body.displayName!, filterSteps: body.filterSteps ?? [], enabled: body.enabled,
  });
  await markUserDeploymentsOutdated(c.env.DB, user.id);
  return c.json({ monitor: toApiMonitor(monitor) });
});

apiAuth.put("/monitors/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  if (!await getMonitor(c.env.DB, user.id, id)) return c.json({ error: "not_found" }, 404);
  let body;
  try { body = parseMonitorMutation(await c.req.json(), false); }
  catch (error) { return c.json({ error: error instanceof GraphInputError ? error.code : "invalid_form" }, 400); }
  if (body.connectionId && !await getConnection(c.env.DB, user.id, body.connectionId)) return c.json({ error: "connection_not_found" }, 404);
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
  let body;
  try { body = parseSinkMutation(await c.req.json(), true); }
  catch (error) { return c.json({ error: error instanceof GraphInputError ? error.code : "invalid_form" }, 400); }
  const dest = await getDestination(c.env.DB, user.id, body.destinationId!);
  if (!dest) return c.json({ error: "destination_not_found" }, 404);
  const sink = await createSink(c.env.DB, {
    monitorId,
    destinationId: body.destinationId!,
    filterSteps: body.filterSteps,
  });
  await markUserDeploymentsOutdated(c.env.DB, user.id);
  return c.json({ sink: toApiSink(sink) });
});

apiAuth.put("/sinks/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  let body;
  try { body = parseSinkMutation(await c.req.json(), false); }
  catch (error) { return c.json({ error: error instanceof GraphInputError ? error.code : "invalid_form" }, 400); }
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
  if (!kids.length) return {job: isStaleRunningJob(parent) ? {...parent,status:"failed",lastError:parent.lastError ?? staleRunningJobMessage(parent)} : parent, kids};
  const aggregated: JobRecord = {
    ...parent,
    status: aggregateStatus(parent, kids),
  };
  const failed = kids.find((k) => k.status === "failed");
  const stale = kids.find((k) => isStaleRunningJob(k));
  const lastSucceeded = [...kids]
    .reverse()
    .find((k) => k.status === "succeeded");
  aggregated.lastError =
    failed?.lastError ?? (stale ? staleRunningJobMessage(stale) : null);
  aggregated.result = lastSucceeded?.result ?? null;

  const running = kids.find(
    (k) => k.status === "running" && !isStaleRunningJob(k),
  );
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

api.route("/",deploymentAppliedRoutes());
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

// --- API response shapers -------------------------------------------------

function toApiConnection(c: ConnectionRow) {
  return {
    id: c.id,
    provider: c.provider,
    displayName: c.display_name,
    externalAccountId: c.external_account_id,
    providerInstallationId: c.provider_installation_id,
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
    graphSelection: d.graph_selection_json?parseOrderedDeploymentSelection(JSON.parse(d.graph_selection_json)):null,
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
