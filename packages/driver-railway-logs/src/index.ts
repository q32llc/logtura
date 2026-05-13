/**
 * `railway-logs` source driver.
 *
 * Tails Railway runtime logs with the same GraphQL WebSocket endpoint used by
 * Railway's CLI, but uses the environment-level stream:
 *
 *   subscription { environmentLogs(environmentId, anchorDate, afterDate, afterLimit) }
 *
 * The important detail is the anchor/after form. The simpler
 * `environmentLogs(environmentId, limit)` subscription acknowledges but did
 * not deliver live rows in our probe. The anchor form streams live rows and
 * carries `tags.serviceId`, so one helper process can demux all selected
 * services in an environment.
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

export interface RailwayCredentials {
  apiToken: string;
  /** Optional helper for discovery in CLI/API callers. Runtime does not need it. */
  projectId?: string;
  /** Optional helper for discovery in CLI/API callers. Runtime uses connection.externalAccountId. */
  environmentId?: string;
}

const GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const TAIL_ASSET = "logtura-railway-tail.mjs";
const TAIL_ASSET_PATH = `/opt/logtura/assets/railway-logs/${TAIL_ASSET}`;
const BUN_IMAGE = "oven/bun:1.3.3-debian";

interface RailwayGraphQLError {
  message?: string;
}

export const railwayLogsDriver: ProviderDriver<RailwayCredentials> = {
  id: "railway-logs",
  displayName: "Railway Logs",
  sourceLabel: "Service",
  capabilities: { selection: "list" },

  async verifyCredentials(credentials) {
    const data = await railwayGraphql<{
      projectToken?: {
        id?: string;
        project?: { id?: string; name?: string };
        environment?: { id?: string; name?: string };
      } | null;
    }>(
      credentials.apiToken,
      `query ProjectToken {
        projectToken {
          id
          project { id name }
          environment { id name }
        }
      }`,
      {},
    ).catch(() => null);
    if (data?.projectToken?.project?.id) {
      const project = data.projectToken.project;
      const projectId = project.id!;
      const env = data.projectToken.environment;
      return [
        {
          id: env?.id ?? projectId,
          name: env?.name
            ? `${project.name ?? projectId} · ${env.name}`
            : project.name ?? projectId,
        },
      ];
    }

    // Account/OAuth tokens do not return projectToken. A lightweight projects
    // query proves the token is usable and gives the UI something meaningful.
    const projects = await railwayGraphql<{
      projects?: {
        edges?: Array<{ node?: { id?: string; name?: string } }>;
      };
    }>(
      credentials.apiToken,
      `query Projects {
        projects {
          edges { node { id name } }
        }
      }`,
      {},
    );
    const out = (projects.projects?.edges ?? [])
      .map((edge) => edge.node)
      .filter((node): node is { id: string; name?: string } => Boolean(node?.id))
      .map((project) => ({ id: project.id, name: project.name ?? project.id }));
    if (out.length === 0) {
      throw new ProviderError("Railway token has no visible projects", 403);
    }
    return out;
  },

  async discoverSources({ credentials, accountId }) {
    const projectId = credentials.projectId ?? projectIdFromAccountId(accountId);
    const environmentId =
      credentials.environmentId ?? environmentIdFromAccountId(accountId);
    if (!projectId || !environmentId) {
      throw new ProviderError(
        "Railway discovery requires projectId and environmentId",
        400,
      );
    }
    const data = await railwayGraphql<{
      environment?: {
        id?: string;
        name?: string;
        serviceInstances?: {
          edges?: Array<{
            node?: {
              serviceId?: string;
              serviceName?: string;
              latestDeployment?: { id?: string; status?: string } | null;
            };
          }>;
        };
      };
    }>(
      credentials.apiToken,
      `query EnvironmentInstances($projectId: String!, $environmentId: String!) {
        environment(id: $environmentId, projectId: $projectId) {
          id
          name
          serviceInstances(first: 200) {
            edges {
              node {
                serviceId
                serviceName
                latestDeployment { id status }
              }
            }
          }
        }
      }`,
      { projectId, environmentId },
    );
    const out: DiscoveredSource[] = [];
    for (const edge of data.environment?.serviceInstances?.edges ?? []) {
      const node = edge.node;
      if (!node?.serviceId) continue;
      out.push({
        sourceKind: "railway_service",
        externalId: node.serviceId,
        displayName: node.serviceName ?? node.serviceId,
        metadata: {
          project_id: projectId,
          environment_id: environmentId,
          environment_name: data.environment?.name ?? null,
          latest_deployment_id: node.latestDeployment?.id ?? null,
          latest_deployment_status: node.latestDeployment?.status ?? null,
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
      throw new Error("railway-logs does not support \"all\" selection");
    }

    const connKey = safeKey(connection.id);
    const envs = groupSourcesByEnvironment(connection, selection.sources);
    const components: VectorComponent[] = [];
    const manifest: DriverPipeline["manifest"] = [];
    const sourceKeys: string[] = [];

    for (const [environmentId, sources] of envs) {
      assertSafeRailwayId(environmentId, "environment id");
      const sourceKey = `railway_${connKey}_${safeKey(environmentId)}_tail`;
      components.push({
        key: sourceKey,
        kind: "source",
        yaml: railwayExecSourceYaml(environmentId, sources),
      });
      sourceKeys.push(sourceKey);
      manifest.push({
        id: sourceKey,
        role: "source",
        category: "primary",
        label: "Railway Environment Logs",
        detail: `${sources.length} service${sources.length === 1 ? "" : "s"}`,
        links: { connectionId: connection.id },
      });
      for (const source of sources) {
        manifest.push({
          id: `railway_${connKey}_${safeKey(source.externalId)}`,
          role: "source",
          category: "primary",
          label: `Railway · ${source.displayName}`,
          detail: source.externalId,
          links: { connectionId: connection.id, sourceId: source.id },
        });
      }
    }

    const normalizeKey = `railway_${connKey}_norm`;
    if (sourceKeys.length > 0) {
      components.push({
        key: normalizeKey,
        kind: "transform",
        yaml: railwayNormalizeYaml(sourceKeys),
      });
      manifest.push({
        id: normalizeKey,
        role: "normalize",
        category: "plumbing",
        label: "Normalize · Railway",
        detail: `${sourceKeys.length} environment${sourceKeys.length === 1 ? "" : "s"}`,
        links: { connectionId: connection.id },
      });
    }

    return {
      components,
      outputKey: normalizeKey,
      envVars: [
        {
          name: "RAILWAY_API_TOKEN",
          description:
            "Railway token used to subscribe to environment logs. Project tokens and OAuth access tokens are supported by Railway's log API.",
          source: "credential",
          credentialPath: "apiToken",
          helpUrl: "https://docs.railway.com/reference/public-api#authentication",
        },
      ],
      dockerfileDeps: [
        {
          directive: `COPY --from=${BUN_IMAGE} /usr/local/bin/bun /usr/local/bin/bun`,
        },
      ],
      runtimeAssets: [
        {
          path: TAIL_ASSET,
          content: railwayTailHelperSource(),
          mode: 0o755,
        },
      ],
      manifest,
    };
  },
};

async function railwayGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: railwayHeaders(token),
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new ProviderError(
      `Railway GraphQL failed: ${res.status} ${body.slice(0, 200)}`,
      res.status,
    );
  }
  const data = JSON.parse(body) as {
    data?: T;
    errors?: RailwayGraphQLError[];
  };
  if (data.errors?.length) {
    const message = data.errors.map((error) => error.message).join("; ");
    throw new ProviderError(`Railway GraphQL errors: ${message}`, 400);
  }
  if (!data.data) throw new ProviderError("Railway GraphQL returned no data", 502);
  return data.data;
}

function railwayHeaders(token: string): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (isProjectToken(token)) headers["project-access-token"] = token;
  else headers.authorization = `Bearer ${token}`;
  return headers;
}

function groupSourcesByEnvironment(
  connection: ConnectionRef,
  sources: SourceRef[],
): Map<string, SourceRef[]> {
  const out = new Map<string, SourceRef[]>();
  for (const source of sources) {
    if (source.sourceKind !== "railway_service") {
      throw new Error(`Unknown Railway source kind: ${source.sourceKind}`);
    }
    assertSafeRailwayId(source.externalId, "service id");
    const environmentId = String(
      source.metadata?.environment_id ??
        source.metadata?.environmentId ??
        connection.externalAccountId ??
        "",
    );
    if (!environmentId) {
      throw new Error(
        `Railway source ${source.externalId} is missing environment id`,
      );
    }
    const list = out.get(environmentId) ?? [];
    list.push(source);
    out.set(environmentId, list);
  }
  return out;
}

function railwayExecSourceYaml(
  environmentId: string,
  sources: Array<{ externalId: string; displayName: string }>,
): string {
  const servicesJson = JSON.stringify(
    sources.map((source) => ({
      id: source.externalId,
      name: source.displayName,
    })),
  );
  const script = `exec bun ${TAIL_ASSET_PATH} ${shellQuote(environmentId)} ${shellQuote(servicesJson)}`;
  return [
    `    type: exec`,
    `    mode: streaming`,
    `    include_stderr: false`,
    `    command:`,
    `      - sh`,
    `      - -c`,
    `      - |`,
    `        ${script}`,
    `    decoding:`,
    `      codec: json`,
    `    framing:`,
    `      method: newline_delimited`,
  ].join("\n");
}

function railwayTailHelperSource(): string {
  return String.raw`const [environmentId, servicesJson] = process.argv.slice(2);
const services = JSON.parse(servicesJson);
const serviceNames = new Map(services.map((service) => [service.id, service.name]));
const selectedServiceIds = new Set(services.map((service) => service.id));
const token = process.env.RAILWAY_API_TOKEN;
if (!token) {
  console.error("RAILWAY_API_TOKEN is required");
  process.exit(1);
}

const GRAPHQL_WS_URL = "wss://backboard.railway.com/graphql/v2";
const STREAM_WINDOW_MS = 60 * 60 * 1000;
const AFTER_LIMIT = 500;
const HELPER_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const seen = [];
const seenSet = new Set();
const helperErrors = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authHeaders() {
  if (token.startsWith("p_") || token.startsWith("project_")) {
    return { "project-access-token": token };
  }
  return { authorization: "Bearer " + token };
}

function remember(event) {
  const key = [
    event.timestamp,
    event.serviceId,
    event.deploymentId,
    event.deploymentInstanceId,
    event.message,
    event.attrs?.event ?? "",
  ].join("\u001f");
  if (seenSet.has(key)) return false;
  seenSet.add(key);
  seen.push(key);
  while (seen.length > 10000) {
    const old = seen.shift();
    if (old) seenSet.delete(old);
  }
  return true;
}

function parseAttributeValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function flattenAttributes(attributes) {
  const out = {};
  for (const attr of attributes ?? []) {
    if (!attr || typeof attr.key !== "string") continue;
    out[attr.key] = parseAttributeValue(attr.value);
  }
  return out;
}

function emitHelperError(message, extra = {}) {
  const now = Date.now();
  const signature = String(message).slice(0, 240);
  const state = helperErrors.get(signature) ?? { lastAt: 0, suppressed: 0 };
  if (now - state.lastAt < HELPER_ERROR_COOLDOWN_MS) {
    state.suppressed += 1;
    helperErrors.set(signature, state);
    return;
  }
  const suppressed = state.suppressed;
  helperErrors.set(signature, { lastAt: now, suppressed: 0 });
  process.stdout.write(JSON.stringify({
    level: "error",
    severity: "error",
    source: "logtura_railway_helper",
    environmentId,
    message: "railway environment log tail: " + message,
    helperErrorSuppressed: suppressed,
    helperErrorCooldownMs: HELPER_ERROR_COOLDOWN_MS,
    timestamp: new Date(now).toISOString(),
    ...extra,
  }) + "\n");
}

function normalizeRow(row) {
  const tags = row.tags ?? {};
  const serviceId = tags.serviceId ?? "";
  const attrs = flattenAttributes(row.attributes);
  return {
    ...row,
    attrs,
    serviceId,
    serviceName: serviceNames.get(serviceId) ?? serviceId,
    environmentId: tags.environmentId ?? environmentId,
    projectId: tags.projectId ?? null,
    deploymentId: tags.deploymentId ?? null,
    deploymentInstanceId: tags.deploymentInstanceId ?? null,
    snapshotId: tags.snapshotId ?? null,
  };
}

function shouldKeep(row) {
  const serviceId = row.tags?.serviceId;
  return typeof serviceId === "string" && selectedServiceIds.has(serviceId);
}

function subscribeOnce() {
  return new Promise((resolve, reject) => {
    const anchorDate = new Date().toISOString();
    const afterDate = new Date(Date.now() + STREAM_WINDOW_MS).toISOString();
    const ws = new WebSocket(GRAPHQL_WS_URL, {
      protocols: ["graphql-transport-ws"],
      headers: authHeaders(),
    });
    const id = "railway_env_logs";
    let settled = false;
    let closeTimer;

    const query = [
      "subscription EnvironmentLogs($environmentId: String!, $filter: String, $anchorDate: String, $afterDate: String, $afterLimit: Int) {",
      "  environmentLogs(environmentId: $environmentId, filter: $filter, anchorDate: $anchorDate, afterDate: $afterDate, afterLimit: $afterLimit) {",
      "    timestamp",
      "    message",
      "    severity",
      "    tags {",
      "      projectId",
      "      environmentId",
      "      serviceId",
      "      deploymentId",
      "      deploymentInstanceId",
      "      snapshotId",
      "    }",
      "    attributes {",
      "      key",
      "      value",
      "    }",
      "  }",
      "}",
    ].join("\n");

    function send(payload) {
      ws.send(JSON.stringify(payload));
    }

    function done(err) {
      if (settled) return;
      settled = true;
      clearTimeout(closeTimer);
      try {
        send({ id, type: "complete" });
      } catch {}
      try {
        ws.close();
      } catch {}
      if (err) reject(err);
      else resolve();
    }

    ws.onopen = () => {
      send({ type: "connection_init" });
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "connection_ack") {
        send({
          id,
          type: "subscribe",
          payload: {
            query,
            variables: {
              environmentId,
              filter: "",
              anchorDate,
              afterDate,
              afterLimit: AFTER_LIMIT,
            },
          },
        });
        closeTimer = setTimeout(() => done(), STREAM_WINDOW_MS - 5000);
        return;
      }
      if (message.type === "ping") {
        send({ type: "pong", payload: message.payload });
        return;
      }
      if (message.type === "next") {
        if (message.payload?.errors?.length) {
          const text = message.payload.errors.map((error) => error.message).join("; ");
          emitHelperError(text || "GraphQL subscription error", { graphqlErrors: message.payload.errors });
        }
        for (const row of message.payload?.data?.environmentLogs ?? []) {
          if (!shouldKeep(row)) continue;
          const event = normalizeRow(row);
          if (!remember(event)) continue;
          process.stdout.write(JSON.stringify(event) + "\n");
        }
        return;
      }
      if (message.type === "error") {
        done(new Error(JSON.stringify(message.payload)));
      }
      if (message.type === "complete") {
        done();
      }
    };
    ws.onerror = (event) => {
      done(new Error(event?.message || "Railway WebSocket error"));
    };
    ws.onclose = () => {
      done();
    };
  });
}

for (;;) {
  try {
    await subscribeOnce();
  } catch (err) {
    emitHelperError(err instanceof Error ? err.message : String(err));
  }
  await sleep(3000);
}`;
}

function railwayNormalizeYaml(inputKeys: string[]): string {
  const vrl = [
    `.script = string(.serviceName) ?? string(.serviceId) ?? "railway"`,
    `.timestamp = .timestamp`,
    `raw_level = downcase(string(.severity) ?? string(.attrs.level) ?? string(.level) ?? "info")`,
    `.level = if raw_level == "warning" { "warn" } else { raw_level }`,
    `if .level == "" { .level = "info" }`,
    `.error = .level == "error" || .level == "fatal" || .level == "panic" || .level == "critical"`,
    `body = string(.message) ?? ""`,
    `if body == "" { body = string(.attrs.message) ?? string(.attrs.event) ?? "" }`,
    `if body == "" { body = encode_json(.) }`,
    `.message = "[" + .script + "] " + body`,
    `if .error {`,
    `  .error_reason = "railway_log"`,
    `  lines = split(body, "\\n")`,
    `  first = string(lines[0]) ?? body`,
    `  .exceptions = [{ "name": "Error", "message": first, "stack": body }]`,
    `} else {`,
    `  del(.error_reason)`,
    `  del(.exceptions)`,
    `}`,
  ];
  return [
    "    type: remap",
    `    inputs: [${inputKeys.map((key) => `"${key}"`).join(", ")}]`,
    "    source: |-",
    ...vrl.map((line) => `      ${line}`),
  ].join("\n");
}

function projectIdFromAccountId(accountId: string): string {
  return accountId.includes(":") ? accountId.split(":")[0]! : "";
}

function environmentIdFromAccountId(accountId: string): string {
  return accountId.includes(":") ? accountId.split(":")[1]! : accountId;
}

function isProjectToken(token: string): boolean {
  return token.startsWith("p_") || token.startsWith("project_");
}

function assertSafeRailwayId(value: string, label: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`unsafe Railway ${label}: ${value}`);
  }
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
