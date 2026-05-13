/**
 * `fly-log-tail` source driver.
 *
 * Tails `flyctl logs --json -a <app>` over Vector's `exec` source.
 * Identity is a Fly API token (preferably read-only, minted via
 * `fly tokens create readonly -o <org>`); discovery hits Fly's
 * Machines API to list apps.
 */
import {
  type ConnectionRef,
  type DiscoveredSource,
  type DriverPipeline,
  type ProviderDriver,
  ProviderError,
  type ProviderSelection,
  type SourceRef,
  type VectorComponent,
} from "@logtura/core";

const REST_BASE = "https://api.fly.io";
const MACHINES_BASE = "https://api.machines.dev";

export interface FlyCredentials {
  apiToken: string;
}

/** Fly accepts two token shapes: bare-bearer (legacy) and macaroon
 *  ("FlyV1 fm1r_… / fm2_…"). The header prefix depends on which
 *  shape the user pasted. */
export function flyAuthHeader(token: string): string {
  for (const part of token.split(",")) {
    const prefix = part.split("_")[0];
    if (prefix === "fm1r" || prefix === "fm2") return `FlyV1 ${token}`;
  }
  return `Bearer ${token}`;
}

interface FlyOrgNode {
  slug?: string;
}

/** Minimal listFlyOrgs — just what the driver needs (slugs). */
async function listFlyOrgSlugs(authHeader: string): Promise<string[]> {
  const query = `query($admin: Boolean!) {
    organizations(admin: $admin) {
      nodes { slug }
    }
  }`;
  const res = await fetch(`${REST_BASE}/graphql`, {
    method: "POST",
    headers: {
      authorization: authHeader,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query, variables: { admin: false } }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new ProviderError(
      `Fly listFlyOrgs failed: ${res.status} ${bodyText.slice(0, 200)}`,
      res.status,
    );
  }
  const data = JSON.parse(bodyText) as {
    data?: { organizations?: { nodes?: Array<FlyOrgNode | null> } };
    errors?: Array<{ message?: string }>;
  };
  if (data.errors?.length) {
    throw new ProviderError(
      `Fly GraphQL errors: ${data.errors.map((e) => e.message).join("; ")}`,
      400,
    );
  }
  const out: string[] = [];
  for (const n of data.data?.organizations?.nodes ?? []) {
    if (n && typeof n.slug === "string") out.push(n.slug);
  }
  return out;
}

export const flyLogTailDriver: ProviderDriver<FlyCredentials> = {
  id: "fly-log-tail",
  displayName: "Fly.io log tail",
  sourceLabel: "App",
  // No native "subscribe to all apps in the org". flyctl logs is
  // per-app. Callers wanting "all" semantics expand the selection at
  // picking time.
  capabilities: { selection: "list" },

  async verifyCredentials(creds) {
    // Token validity is implicit in a successful org list; Fly
    // doesn't have a dedicated /verify endpoint.
    const slugs = await listFlyOrgSlugs(flyAuthHeader(creds.apiToken));
    if (slugs.length === 0) {
      throw new ProviderError("Fly token has no visible orgs", 403);
    }
    return slugs.map((s) => ({ id: s, name: s }));
  },

  async discoverSources({ credentials, accountId }) {
    // Apps live under an org. accountId is the org slug; we list
    // apps and treat each as one source. Machines API exposes
    // /v1/apps?org_slug=… for this.
    const url = `${MACHINES_BASE}/v1/apps?org_slug=${encodeURIComponent(accountId)}`;
    const res = await fetch(url, {
      headers: { authorization: flyAuthHeader(credentials.apiToken) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(
        `Fly apps list failed: ${res.status} ${body.slice(0, 200)}`,
        res.status,
      );
    }
    const data = (await res.json()) as {
      apps?: Array<{ id?: string; name?: string; machine_count?: number }>;
    };
    const apps = data.apps ?? [];
    const sources: DiscoveredSource[] = [];
    for (const app of apps) {
      const name = app.name ?? app.id;
      if (!name) continue;
      sources.push({
        sourceKind: "fly_app",
        externalId: name,
        displayName: name,
        metadata: { machine_count: app.machine_count ?? null },
      });
    }
    return sources;
  },

  generatePipeline({
    connection,
    selection,
  }: {
    connection: ConnectionRef;
    selection: ProviderSelection;
  }): DriverPipeline {
    if (selection.kind === "all") {
      // Should not reach here since supportsAllSelection is false,
      // but the renderer also gates on the flag.
      throw new Error("fly-log-tail does not support \"all\" selection");
    }
    const sources = selection.sources;
    const components: VectorComponent[] = [];
    const manifest: DriverPipeline["manifest"] = [];
    const connKey = safeKey(connection.id);
    const sourceKeys: string[] = [];
    for (const s of sources) {
      if (s.sourceKind !== "fly_app") {
        throw new Error(`Unknown fly source kind: ${s.sourceKind}`);
      }
      const key = `fly_${connKey}_${safeKey(s.externalId)}`;
      components.push({ key, kind: "source", yaml: flyExecSourceYaml(s) });
      sourceKeys.push(key);
      manifest.push({
        id: key,
        role: "source",
        category: "primary",
        label: `App · ${s.displayName}`,
        links: { connectionId: connection.id, sourceId: s.id },
      });
    }
    // One normalize transform per connection fans in every selected
    // app's exec source. outputKey is the normalize's key so
    // downstream tag_conn reads from it.
    const normalizeKey = `fly_${connKey}_norm`;
    if (sourceKeys.length > 0) {
      components.push({
        key: normalizeKey,
        kind: "transform",
        yaml: flyAppNormalizeYaml(sourceKeys),
      });
      manifest.push({
        id: normalizeKey,
        role: "normalize",
        category: "plumbing",
        label: "Normalize · App",
        detail: `${sourceKeys.length} source${sourceKeys.length === 1 ? "" : "s"}`,
        links: { connectionId: connection.id },
      });
    }
    return {
      components,
      outputKey: normalizeKey,
      envVars: [
        {
          name: "FLY_API_TOKEN",
          description:
            "Fly token used by flyctl logs to tail each selected app. Read-only is enough; the forwarder never writes to your account.",
          source: "credential",
          credentialPath: "apiToken",
          helpUrl: "https://fly.io/user/personal_access_tokens",
        },
      ],
      dockerfileDeps: [
        // flyctl already ships in our kitchen-sink forwarder image;
        // declaring the dep here is mostly self-documentation and a
        // belt for self-deploy users who build their own image.
        {
          install:
            "curl -L https://fly.io/install.sh | sh && cp /root/.fly/bin/flyctl /usr/local/bin/flyctl",
          aptPackages: ["curl", "ca-certificates"],
        },
      ],
      manifest,
    };
  },
};

/** Build the Vector exec source for a single fly app.
 *
 *  `flyctl logs --json -a <app>` emits JSON events but in the
 *  pretty-printed multi-line shape (same trap as wrangler tail).
 *  Vector's exec source with `codec: json` and the default
 *  newline_delimited framing tries one line at a time and fails on
 *  every line of a multi-line object. Pipe through `jq -c` to
 *  compact each value onto a single line.
 *
 *  The pipeline also:
 *    1. Forces flyctl's stdout LINE-buffered with `stdbuf -oL`.
 *       libc defaults to BLOCK buffering on a pipe (4 KB), so
 *       without this, events stall in flyctl's buffer until
 *       enough accumulate. `jq -c --unbuffered` only handles
 *       jq's output buffering, not flyctl's.
 *    2. Injects the app name as a jq VARIABLE via `--arg app`,
 *       not via shell-string interpolation. Earlier attempts to
 *       embed it inline tripped over double-escaping and produced
 *       an invalid jq filter (jq died, Vector then read flyctl's
 *       raw multi-line output and JSON-parse-errored on every
 *       line). `--arg` sidesteps the entire escaping problem.
 *
 *  shellQuote() restricts externalId to [a-zA-Z0-9_-]+ so it's safe
 *  to interpolate the `-a` arg.
 *
 *  NOTE the `$$app`: Vector pre-processes the WHOLE config file for
 *  `$VAR` / `${VAR}` env-var substitution before parsing any
 *  structure, even inside string literals destined for `sh -c`. A
 *  bare `$app` in the jq filter would be substituted to "" at load
 *  time (no env var named `app`) and Vector crashes with "Missing
 *  environment variable in config. name = app". The escape `$$`
 *  collapses to a single `$` in Vector's pre-pass, so jq receives
 *  `$app` and resolves it from `--arg app`. */
function flyExecSourceYaml(source: SourceRef): string {
  const app = shellQuote(source.externalId);
  const command = `stdbuf -oL flyctl logs --json -a ${app} | jq -c --unbuffered --arg app ${app} '. + {app: $$app}'`;
  return [
    `    type: exec`,
    `    command: ["sh", "-c", ${JSON.stringify(command)}]`,
    `    mode: streaming`,
    // flyctl + jq write non-JSON status/error lines to stderr.
    // Vector's exec source decodes stderr through the same JSON
    // pipeline by default; disable to avoid spurious parse errors.
    `    include_stderr: false`,
    `    decoding:`,
    `      codec: json`,
  ].join("\n");
}

function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Refuse anything that could break out of the shell quoting. App
 *  names are validated by Fly to a strict charset (lowercase
 *  alphanum + hyphen) and we discovered them via our own API call,
 *  so anything weirder than that means tampering or a Fly change we
 *  haven't seen. Better to fail loudly. */
function shellQuote(s: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) {
    throw new Error(`unsafe fly app name for shell: ${s}`);
  }
  return s;
}

/**
 * Normalize fly log events to the uniform shape (.message, .level,
 * .error, .script, .timestamp) so downstream filters can be
 * provider-agnostic. flyctl logs --json shape (per emitted line):
 *   { timestamp, level, message, region, instance, ... }
 * The source wrapper around `flyctl logs` pre-tags every event with
 * `.app = "<app>"` (the app name isn't in flyctl's payload — it
 * knows from `-a` and doesn't repeat it), so .script is always
 * populated here. Mirrors cloudflare's .scriptName → .script
 * convention so per-app/per-worker monitor filters use the same
 * field.
 */
function flyAppNormalizeYaml(inputKeys: string[]): string {
  const vrl = [
    `.script = string(.app) ?? "fly"`,
    `.timestamp = .timestamp`,
    `body = string(.message) ?? ""`,
    `if body == "" { body = "(no message)" }`,
    // Fly only sees the STREAM (stdout=info, stderr=error), not
    // the semantic level — so Node's console.warn / console.debug
    // both look like "error" to Fly because they hit stderr. To
    // route correctly, try parsing the body as a structured log
    // (pino, winston, zap, bunyan, structlog all emit JSON) and
    // prefer the embedded level when present.
    //
    // String levels: error / warn / info / debug / trace / fatal /
    // panic / critical (plus the "warning" variant).
    //
    // Numeric levels: pino's scheme — 10/20/30/40/50/60. We treat
    // 0–9 and unknown as "no opinion" → fall back to Fly's stream.
    // Try `level` (winston/pino/bunyan/zap/logrus/structlog),
    // `severity` (GCP / Google Cloud Logging), and `lvl` (some Go
    // loggers). Normalize uppercase forms (Go slog, Rust tracing
    // emit "INFO" etc) and aliases ("warning"→"warn",
    // "emergency"/"alert"→"fatal"/"error").
    //
    // Numeric levels: pino + bunyan use 10/20/30/40/50/60.
    // Cumulative-if pattern (monotonic overwrite) instead of
    // else-if chains — VRL rejects `else` on a new line.
    `fly_level = string(.level) ?? "info"`,
    `inner_level = ""`,
    `parsed = parse_json(body) ?? null`,
    `if is_object(parsed) {`,
    `  raw_str = string(parsed.level) ?? string(parsed.severity) ?? string(parsed.lvl) ?? ""`,
    `  if raw_str != "" {`,
    `    lower = downcase(raw_str)`,
    `    if lower == "warning" { inner_level = "warn" }`,
    `    if lower == "warn" || lower == "info" || lower == "debug" || lower == "trace" { inner_level = lower }`,
    `    if lower == "error" || lower == "fatal" || lower == "panic" || lower == "critical" { inner_level = lower }`,
    `    if lower == "alert" { inner_level = "error" }`,
    `    if lower == "emergency" { inner_level = "fatal" }`,
    `  } else {`,
    `    n = int(parsed.level) ?? 0`,
    `    if n >= 10 { inner_level = "debug" }`,
    `    if n >= 30 { inner_level = "info" }`,
    `    if n >= 40 { inner_level = "warn" }`,
    `    if n >= 50 { inner_level = "error" }`,
    `    if n >= 60 { inner_level = "fatal" }`,
    `  }`,
    `}`,
    `effective = if inner_level != "" { inner_level } else { fly_level }`,
    `.level = effective`,
    `.error = effective == "error" || effective == "fatal" || effective == "panic" || effective == "critical"`,
    // Always prefix with [app] so monitors WITHOUT rollup still
    // deliver tagged Slack messages. Bare bodies lose their app
    // association otherwise.
    `.message = "[" + .script + "] " + body`,
  ];
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((k) => `"${k}"`).join(", ")}]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}
