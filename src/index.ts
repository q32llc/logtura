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
  decryptConnectionCredentials,
  deleteConnection,
  getConnection,
  listConnections,
  listSources,
  markDiscovered,
  setSourceSelections,
  upsertSources,
  type ConnectionRow,
  type LogSourceRow,
} from "./db";
import type { AppContext } from "./env";
import { generateBundle } from "./generator";
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

  // Run initial discovery synchronously so the next page has data.
  try {
    const discovered = await driver.discoverSources({
      credentials,
      accountId,
    });
    await upsertSources(c.env.DB, connection.id, discovered);
    await markDiscovered(c.env.DB, connection.id);
  } catch (err) {
    console.error("initial discovery failed", err);
    // Non-fatal — connection is still created.
  }

  return c.json({ connection: toApiConnection(connection) });
});

apiAuth.get("/connections/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const connection = await getConnection(c.env.DB, user.id, id);
  if (!connection) return c.json({ error: "not_found" }, 404);
  const sources = await listSources(c.env.DB, connection.id);
  const driver = getProvider(connection.provider);
  return c.json({
    connection: toApiConnection(connection),
    sources: sources.map((s) => toApiSource(s, driver)),
  });
});

apiAuth.post("/connections/:id/sources", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const connection = await getConnection(c.env.DB, user.id, id);
  if (!connection) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json()) as { selectedSourceIds?: string[] };
  const selected = new Set(body.selectedSourceIds ?? []);
  await setSourceSelections(c.env.DB, connection.id, selected);
  const sources = await listSources(c.env.DB, connection.id);
  const driver = getProvider(connection.provider);
  return c.json({ sources: sources.map((s) => toApiSource(s, driver)) });
});

apiAuth.post("/connections/:id/discover", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const connection = await getConnection(c.env.DB, user.id, id);
  if (!connection) return c.json({ error: "not_found" }, 404);
  if (!connection.external_account_id) {
    return c.json({ error: "no_account_id" }, 400);
  }
  const driver = getProvider(connection.provider);
  if (!driver) return c.json({ error: "unknown_provider" }, 400);
  const credentials = await decryptConnectionCredentials(c.env, connection);
  try {
    const discovered = await driver.discoverSources({
      credentials,
      accountId: connection.external_account_id,
    });
    await upsertSources(c.env.DB, connection.id, discovered);
    await markDiscovered(c.env.DB, connection.id);
  } catch (err) {
    if (err instanceof ProviderError) {
      return c.json(
        { error: "discovery_failed", message: err.message },
        400,
      );
    }
    throw err;
  }
  const sources = await listSources(c.env.DB, connection.id);
  return c.json({ sources: sources.map((s) => toApiSource(s, driver)) });
});

apiAuth.delete("/connections/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  await deleteConnection(c.env.DB, user.id, id);
  return c.json({ ok: true });
});

apiAuth.get("/connections/:id/bundle", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const connection = await getConnection(c.env.DB, user.id, id);
  if (!connection) return c.json({ error: "not_found" }, 404);
  const all = await listSources(c.env.DB, connection.id);
  const selected = all.filter((s) => s.selected === 1);
  const bundle = generateBundle({
    connection,
    selectedSources: selected,
  });
  return c.json({
    vectorYaml: bundle.vectorYaml,
    dockerfile: bundle.dockerfile,
    runCommand: bundle.runCommand,
    envVars: bundle.envVars,
    selectedCount: bundle.selectedCount,
  });
});

api.route("/", apiAuth);
app.route("/api", api);

// --- SPA fallback ---------------------------------------------------------
// Anything we didn't handle falls through to ASSETS, which serves
// index.html (Vite-built React app) for non-file paths thanks to
// not_found_handling = "single-page-application".

app.notFound(async (c) => c.env.ASSETS.fetch(c.req.raw));

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
    sourceKindLabel: driver?.sourceKindLabel(s.source_kind) ?? s.source_kind,
    externalId: s.external_id,
    displayName: s.display_name,
    metadata: s.metadata_json ? JSON.parse(s.metadata_json) : null,
    selected: s.selected === 1,
    discoveredAt: s.discovered_at,
  };
}

export default app;
