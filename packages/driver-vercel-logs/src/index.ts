/**
 * `vercel-logs` source driver.
 *
 * Tails Vercel Runtime Logs over the REST API:
 * GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs
 *
 * This is intentionally not Vercel Drains. Drains are Pro/Enterprise-only;
 * Runtime Logs are available on Hobby, subject to Vercel's short retention
 * window. At runtime a single exec source runs one helper process for the
 * selected projects; the helper discovers each latest READY production
 * deployment, streams its logs, and reconnects.
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

export interface VercelCredentials {
  apiToken: string;
}

interface VercelProject {
  id?: string;
  name?: string;
  framework?: string | null;
  updatedAt?: number;
}

const API_BASE = "https://api.vercel.com";
const TAIL_ASSET = "logtura-vercel-tail.mjs";
const TAIL_ASSET_PATH = `/opt/logtura/assets/vercel-logs/${TAIL_ASSET}`;
const BUN_IMAGE = "oven/bun:1.3.3-debian";

export const vercelLogsDriver: ProviderDriver<VercelCredentials> = {
  id: "vercel-logs",
  displayName: "Vercel Runtime Logs",
  sourceLabel: "Project",
  capabilities: { selection: "list" },

  async verifyCredentials(credentials) {
    const res = await fetch(`${API_BASE}/v2/user`, {
      headers: vercelHeaders(credentials.apiToken),
    });
    const data = await readVercelResponse(res) as { user?: { uid?: string; username?: string; name?: string } };
    const id = data.user?.uid ?? "vercel";
    return [{ id, name: data.user?.username ?? data.user?.name ?? id }];
  },

  async discoverSources({ credentials, accountId }) {
    const url = new URL(`${API_BASE}/v9/projects`);
    url.searchParams.set("limit", "100");
    if (accountId) url.searchParams.set("teamId", accountId);
    const res = await fetch(url, {
      headers: vercelHeaders(credentials.apiToken),
    });
    const data = await readVercelResponse(res) as { projects?: VercelProject[] };
    if (data.projects != null && !Array.isArray(data.projects)) throw new ProviderError("Invalid Vercel project inventory", 502);
    const out: DiscoveredSource[] = [];
    for (const project of data.projects ?? []) {
      if (!project || typeof project.id !== "string" || !project.id) continue;
      out.push({
        sourceKind: "vercel_project",
        externalId: project.id,
        displayName: project.name ?? project.id,
        metadata: {
          framework: project.framework ?? null,
          updated_at: project.updatedAt ?? null,
        },
      });
    }
    return out;
  },

  generatePipeline({
    connection,
    selection,
  }: {
    connection: ConnectionRef;
    selection: ProviderSelection;
  }): DriverPipeline {
    if (selection.kind === "all") {
      throw new Error("vercel-logs does not support \"all\" selection");
    }
    const connKey = safeKey(connection.id);
    const components: VectorComponent[] = [];
    const manifest: DriverPipeline["manifest"] = [];
    const sources = selection.sources;
    const perProjectKeys: string[] = [];
    for (const source of selection.sources) {
      if (source.sourceKind !== "vercel_project") {
        throw new Error(`Unknown Vercel source kind: ${source.sourceKind}`);
      }
      assertSafeVercelId(source.externalId, "project id");
      const projectKey = `vercel_${connKey}_${safeKey(source.id)}`;
      manifest.push({
        id: projectKey,
        role: "source",
        category: "primary",
        label: `Vercel · ${source.displayName}`,
        detail: source.externalId,
        links: {
          connectionId: connection.id,
          sourceId: source.id,
          parentId: `vercel_${connKey}_tail`,
        },
      });
    }
    const sourceKey = `vercel_${connKey}_tail`;
    if (sources.length > 0) {
      components.push({
        key: sourceKey,
        kind: "source",
        yaml: vercelExecSourceYaml(sources, connection.externalAccountId ?? ""),
      });
      manifest.push({
        id: sourceKey,
        role: "source",
        category: "primary",
        label: "Vercel Runtime Logs",
        detail: `${sources.length} project${sources.length === 1 ? "" : "s"}`,
        links: { connectionId: connection.id },
      });
    }
    const normalizeKey = `vercel_${connKey}_norm`;
    if (sources.length > 0) {
      components.push({
        key: normalizeKey,
        kind: "transform",
        yaml: vercelNormalizeYaml([sourceKey]),
      });
      manifest.push({
        id: normalizeKey,
        role: "normalize",
        category: "plumbing",
        label: "Normalize · Vercel",
        detail: `${sources.length} project${sources.length === 1 ? "" : "s"}`,
        links: { connectionId: connection.id },
      });
      for (const source of selection.sources) {
        const projectKey = `vercel_${connKey}_${safeKey(source.id)}`;
        perProjectKeys.push(projectKey);
        components.push({
          key: projectKey,
          kind: "transform",
          yaml: vercelProjectFilterYaml(normalizeKey, source.externalId),
        });
      }
    }
    const outputKey =
      perProjectKeys.length > 0
        ? `vercel_${connKey}_by_project`
        : normalizeKey;
    if (perProjectKeys.length > 0) {
      components.push({
        key: outputKey,
        kind: "transform",
        yaml: passThroughMergeYaml(perProjectKeys),
      });
      manifest.push({
        id: outputKey,
        role: "normalize",
        category: "plumbing",
        label: "Merge · Vercel projects",
        detail: `${perProjectKeys.length} project${perProjectKeys.length === 1 ? "" : "s"}`,
        links: { connectionId: connection.id },
      });
    }
    return {
      components,
      outputKey,
      envVars: [
        {
          name: "VERCEL_API_TOKEN",
          description: "Vercel API token with access to selected projects.",
          source: "credential",
          credentialPath: "apiToken",
          helpUrl: "https://vercel.com/account/settings/tokens",
        },
        ...(connection.externalAccountId
          ? [
              {
                name: "VERCEL_TEAM_ID",
                description: "Vercel team id for the selected projects.",
                source: "external_account_id" as const,
              },
            ]
          : []),
      ],
      dockerfileDeps: [
        {
          directive: `COPY --from=${BUN_IMAGE} /usr/local/bin/bun /usr/local/bin/bun`,
        },
      ],
      runtimeAssets: [
        {
          path: TAIL_ASSET,
          content: vercelTailHelperSource(),
          mode: 0o755,
        },
      ],
      manifest,
    };
  },
};

/** Provider bodies can contain private data; keep library failures stable. */
async function readVercelResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError(`Vercel request failed: ${response.status}`, response.status);
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new ProviderError("Invalid Vercel JSON response", 502); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProviderError("Invalid Vercel response", 502);
  return body as Record<string, unknown>;
}

function vercelHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
}

function vercelExecSourceYaml(
  sources: SourceRef[],
  teamId: string,
): string {
  const projectsJson = JSON.stringify(
    sources.map((source) => ({
      id: source.externalId,
      name: source.displayName,
    })),
  );
  const script = [
    `exec bun ${TAIL_ASSET_PATH} ${shellQuote(teamId)} ${shellQuote(projectsJson)}`,
  ].join("\n");
  return [
    `    type: exec`,
    `    mode: streaming`,
    `    include_stderr: false`,
    `    command:`,
    `      - sh`,
    `      - -c`,
    `      - |`,
    ...script.split("\n").map((line) => `        ${line}`),
    `    decoding:`,
    `      codec: json`,
    `    framing:`,
    `      method: newline_delimited`,
  ].join("\n");
}

function vercelTailHelperSource(): string {
  return String.raw`const [teamId, projectsJson] = process.argv.slice(2);
const projects = JSON.parse(projectsJson);
const token = process.env.VERCEL_API_TOKEN;
if (!token) {
  console.error("VERCEL_API_TOKEN is required");
  process.exit(1);
}
const seen = new Map();
const helperErrors = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HELPER_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
class TailError extends Error {}

function isExpectedStreamRestart(err) {
  return Boolean(err && typeof err === "object" && err.name === "AbortError");
}

async function vercelFetch(url, options, failureMessage) {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (isExpectedStreamRestart(err)) throw err;
    throw new TailError(failureMessage);
  }
}

async function requireSuccess(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new TailError("Vercel request failed: HTTP " + response.status);
  }
}

async function vercelJson(path, params) {
  const url = new URL(path, "https://api.vercel.com");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await vercelFetch(url, {
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      signal: ac.signal,
    }, "Vercel deployment request failed");
    await requireSuccess(res);
    let data;
    try { data = await res.json(); }
    catch (err) {
      if (isExpectedStreamRestart(err)) throw err;
      throw new TailError("Invalid Vercel JSON response");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new TailError("Invalid Vercel response");
    return data;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

async function latestDeployment(projectId) {
  const data = await vercelJson("/v6/deployments", {
    teamId,
    projectId,
    target: "production",
    state: "READY",
    limit: "1",
  });
  if (!Array.isArray(data.deployments)) throw new TailError("Invalid Vercel deployment inventory");
  if (!data.deployments.length) return null;
  const id = data.deployments[0]?.uid;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new TailError("Invalid Vercel deployment identity");
  return id;
}

function remember(projectId, rowId) {
  let projectSeen = seen.get(projectId);
  if (!projectSeen) {
    projectSeen = [];
    seen.set(projectId, projectSeen);
  }
  if (projectSeen.includes(rowId)) return false;
  projectSeen.push(rowId);
  if (projectSeen.length > 5000) projectSeen.splice(0, projectSeen.length - 5000);
  return true;
}

function errorMessage(err) {
  return err instanceof TailError ? err.message : "Vercel stream request failed";
}

function emitHelperError(project, err) {
  const now = Date.now();
  const message = errorMessage(err);
  const signature = message.slice(0, 240);
  const state = helperErrors.get(project.id) ?? { signature: "", lastAt: 0, suppressed: 0 };
  if (state.signature === signature && now - state.lastAt < HELPER_ERROR_COOLDOWN_MS) {
    state.suppressed += 1;
    helperErrors.set(project.id, state);
    return;
  }
  const suppressed = state.signature === signature ? state.suppressed : 0;
  helperErrors.set(project.id, { signature, lastAt: now, suppressed: 0 });
  const event = {
    level: "error",
    source: "logtura_vercel_helper",
    projectId: project.id,
    projectName: project.name,
    message: "vercel tail " + project.id + ": " + message,
    helperErrorSuppressed: suppressed,
    helperErrorCooldownMs: HELPER_ERROR_COOLDOWN_MS,
    timestampInMs: now,
  };
  process.stdout.write(JSON.stringify(event) + "\n");
}

async function tailProject(project) {
  for (;;) {
    try {
      const deploymentId = await latestDeployment(project.id);
      if (!deploymentId) {
        await sleep(10000);
        continue;
      }
      const url = new URL("/v1/projects/" + project.id + "/deployments/" + deploymentId + "/runtime-logs", "https://api.vercel.com");
      if (teamId) url.searchParams.set("teamId", teamId);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 300000);
      try {
        const res = await vercelFetch(url, {
          headers: { authorization: "Bearer " + token, accept: "application/json" },
          signal: ac.signal,
        }, "Vercel runtime log request failed");
        await requireSuccess(res);
        if (!res.body) throw new TailError("Vercel runtime log stream is missing");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const emitLine = (line) => {
            if (!line.trim()) return;
            let event;
            try { event = JSON.parse(line); }
            catch { throw new TailError("Invalid Vercel runtime log JSON"); }
            if (!event || typeof event !== "object" || Array.isArray(event)) throw new TailError("Invalid Vercel runtime log row");
            const rowId = String(event.rowId ?? "");
            if (!rowId || !remember(project.id, rowId)) return;
            event.projectId = project.id;
            event.projectName = project.name;
            event.deploymentId = deploymentId;
            process.stdout.write(JSON.stringify(event) + "\n");
        };
        try {
          for (;;) {
            let chunk;
            try {
              chunk = await reader.read();
            } catch {
              // Vercel's live stream is finite (currently up to five minutes).
              // Bun can report the server closing it as a rejected read instead
              // of a clean EOF, so reconnect just as we do for normal EOF.
              break;
            }
            const { done, value } = chunk;
            if (done) {
              buffer += decoder.decode();
              emitLine(buffer);
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) emitLine(line);
          }
        } finally {
          ac.abort();
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } finally {
        clearTimeout(timer);
        ac.abort();
      }
    } catch (err) {
      if (!isExpectedStreamRestart(err)) {
        emitHelperError(project, err);
        console.error("vercel tail " + project.id + ": " + errorMessage(err));
      }
    }
    // Successful EOF also needs backoff: short-lived streams must not spin.
    await sleep(3000);
  }
}

await Promise.all(projects.map((project) => tailProject(project)));`;
}

function vercelNormalizeYaml(inputKeys: string[]): string {
  const vrl = [
    `.script = string(.requestPath) ?? string(.domain) ?? "vercel"`,
    `.timestamp = .timestampInMs`,
    `raw_level = downcase(string(.level) ?? "info")`,
    `.level = if raw_level == "warning" { "warn" } else { raw_level }`,
    `status = int(.responseStatusCode) ?? 0`,
    `.error = .level == "error" || status >= 500`,
    `.message = string(.message) ?? encode_json(.)`,
    `if .error {`,
    `  .error_reason = "vercel_runtime_log"`,
    `  lines = split(.message, "\\n")`,
    `  first = string(lines[0]) ?? .message`,
    `  .exceptions = [{ "name": "Error", "message": first, "stack": .message }]`,
    `} else {`,
    `  del(.error_reason)`,
    `  del(.exceptions)`,
    `}`,
    `.message = "[" + .script + "] " + .message`,
  ];
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((key) => `"${key}"`).join(", ")}]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}

function vercelProjectFilterYaml(inputKey: string, projectId: string): string {
  return [
    "    type: filter",
    `    inputs: ["${inputKey}"]`,
    "    condition: |-",
    `      (string(.projectId) ?? "") == ${JSON.stringify(projectId)}`,
  ].join("\n");
}

function passThroughMergeYaml(inputKeys: string[]): string {
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((key) => `"${key}"`).join(", ")}]`,
    "    source: |-",
    "      . = .",
  ].join("\n");
}

function assertSafeVercelId(value: string, label: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`unsafe Vercel ${label}: ${value}`);
  }
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
