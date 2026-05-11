import type {
  ConnectionRow,
  DestinationRow,
  FilterStep,
  LogSourceRow,
  MonitorRow,
  SinkRow,
} from "./db";
import { parseFilterSteps } from "./db";
import {
  type DestinationDriver,
  getDestinationDriver,
} from "./destinations";
import { getProvider } from "./providers";
import type {
  ConnectionRef,
  DockerfileDep,
  EnvVarSpec,
  ProviderDriver,
  SourceRef,
} from "./providers";

export interface BundleEnvVar {
  name: string;
  description: string;
  source: "credential" | "external_account_id" | "destination" | "manual";
  /** When non-null, the bundle UI shows this real value (the user
   *  already provided it via destinations / connections). When null,
   *  the user has to fill the value themselves at docker-run time. */
  value: string | null;
  /** Optional URL the bundle UI surfaces as "create a new one →" so
   *  credential rotation is one click. */
  helpUrl?: string;
  /** When the stored credential exists but is expired/disabled, value
   *  is null and this carries the reason so the UI can explain why
   *  it's not auto-filled. */
  staleReason?: string;
  /** ms epoch when the stored credential expires, if the provider
   *  knows. Surfaced even for fresh credentials so the user can plan
   *  rotation. null = no expiry / unknown. */
  credentialExpiresAt?: number | null;
}

export interface GeneratedBundle {
  vectorYaml: string;
  dockerfile: string;
  runCommand: string;
  envVars: BundleEnvVar[];
  selectedCount: number;
  /** A best-effort summary like "2 monitors → 3 sinks" for the UI. */
  monitorSummary: string;
}

export interface GeneratorMonitor {
  monitor: MonitorRow;
  sinks: GeneratorSink[];
}

export interface GeneratorSink {
  sink: SinkRow;
  destination: DestinationRow;
  /** Pre-decrypted destination config — caller decrypts (so the
   *  generator stays sync and doesn't depend on env). */
  destinationConfig: unknown;
}

export interface GenerateInput {
  connection: ConnectionRow;
  selectedSources: LogSourceRow[];
  monitors: GeneratorMonitor[];
  /**
   * Decrypted credentials JSON for the connection. Lets the generator
   * inline credential env-var values (e.g. CLOUDFLARE_API_TOKEN) into
   * the bundle UI so the user gets a "Copy value" button instead of
   * a placeholder. Trust posture matches destination URLs and the
   * heartbeat token, both of which are already inlined.
   */
  connectionCredentials?: Record<string, unknown>;
  /**
   * Liveness signal config. When kind="logtura", we emit an exec
   * source that pulses every 30s into an http sink that POSTs to
   * logtura's collector with the deployment's bearer token. When
   * kind="none", we skip.
   */
  heartbeat?: {
    kind: "logtura" | "none";
    deploymentId: string;
    /** Public URL the running container reaches for heartbeats. */
    appUrl: string;
  };
  /**
   * Where to ship Vector's internal metrics. kind="none" emits no
   * sink; kind="logtura" posts to /api/metrics/:deploymentId (we
   * record "last received" only — no time series in D1); kind=
   * "destination" routes through the named destination's driver
   * (datadog_metrics, prometheus_remote_write, etc.). The
   * destination's `flows` must include "metrics".
   */
  metrics?:
    | { kind: "none" }
    | { kind: "logtura"; deploymentId: string; appUrl: string }
    | {
        kind: "destination";
        destination: DestinationRow;
        /** Decrypted destination config. Caller decrypts so the
         *  generator stays sync. */
        destinationConfig: unknown;
      };
}

export function generateBundle(input: GenerateInput): GeneratedBundle {
  const driver = getProvider(input.connection.provider);
  if (!driver) {
    throw new Error(`Unknown provider: ${input.connection.provider}`);
  }
  const connectionRef: ConnectionRef = {
    id: input.connection.id,
    externalAccountId: input.connection.external_account_id,
    displayName: input.connection.display_name,
  };
  const sourceRefs: SourceRef[] = input.selectedSources.map((s) => ({
    externalId: s.external_id,
    displayName: s.display_name,
    sourceKind: s.source_kind,
    metadata: s.metadata_json ? JSON.parse(s.metadata_json) : null,
  }));

  const sourceSpec = driver.runtimeSpec(connectionRef);

  const { vectorYaml, sinkEnvVars } = renderVectorYaml(
    connectionRef,
    driver,
    sourceRefs,
    input.monitors,
    input.heartbeat,
    input.metrics,
  );

  const dockerfile = renderDockerfile([sourceSpec.dockerfileDeps].flat());

  const envVars: BundleEnvVar[] = [
    ...sourceSpec.envVars.map((e) => {
      let value: string | null = null;
      if (e.source === "external_account_id") {
        value = input.connection.external_account_id ?? null;
      } else if (
        e.source === "credential" &&
        e.credentialPath &&
        input.connectionCredentials
      ) {
        const v = input.connectionCredentials[e.credentialPath];
        if (typeof v === "string") value = v;
      }
      return {
        name: e.name,
        description: e.description,
        source: e.source,
        value,
        helpUrl: e.helpUrl,
      };
    }),
    ...sinkEnvVars,
  ];

  // Heartbeat env vars — we have the values, populate them inline.
  if (input.heartbeat?.kind === "logtura") {
    envVars.push({
      name: "LOGTURA_HEARTBEAT_URL",
      description:
        "logtura's heartbeat endpoint for this deployment. Receives pulses to confirm the forwarder is running.",
      source: "manual",
      value: `${input.heartbeat.appUrl}/api/heartbeat/${input.heartbeat.deploymentId}`,
    });
    envVars.push({
      name: "LOGTURA_HEARTBEAT_TOKEN",
      description:
        "Bearer token authorizing this deployment to post heartbeats. Per-deployment; revokable from the dashboard.",
      source: "manual",
      value: null, // populated by caller from deployment.heartbeat_token
    });
  }

  // Metrics-to-logtura env var. Same shape as heartbeat — Vector
  // POSTs internal_metrics here. Logtura's endpoint records "last
  // received" only, no time series. For graphs the user wires a
  // metrics destination (datadog_metrics, prometheus_remote_write)
  // and we route through that driver's sink instead.
  if (input.metrics?.kind === "logtura") {
    envVars.push({
      name: "LOGTURA_METRICS_URL",
      description:
        "logtura's metrics endpoint for this deployment. Records last-received timestamp only; for graphs configure a metrics destination.",
      source: "manual",
      value: `${input.metrics.appUrl}/api/metrics/${input.metrics.deploymentId}`,
    });
    // Reuses the heartbeat token — same auth principle, same row.
    envVars.push({
      name: "LOGTURA_METRICS_TOKEN",
      description:
        "Bearer token authorizing this deployment to post metrics. Same secret as the heartbeat token.",
      source: "manual",
      value: null, // populated by caller from deployment.heartbeat_token
    });
  }

  // For metrics-to-a-destination, declare the destination's env vars
  // up-front so the bundle UI shows them and the deploy job populates
  // them. The destination driver knows its own env spec.
  if (input.metrics?.kind === "destination") {
    const m = input.metrics;
    const dDriver = getDestinationDriver(m.destination.kind);
    if (dDriver) {
      const envName = baseDestEnvName(m.destination.display_name).replace(
        /_URL$/,
        "_METRICS",
      );
      for (const e of dDriver.runtimeEnvVars({
        config: m.destinationConfig,
        envVarName: envName,
        displayName: m.destination.display_name,
      })) {
        envVars.push({
          name: e.name,
          description: e.description,
          source: "destination",
          value: dDriver.envVarValue(m.destinationConfig, e.name),
        });
      }
    }
  }

  const runCommand = renderRunCommand(envVars);
  const sinkCount = input.monitors.reduce(
    (n, m) => n + m.sinks.length,
    0,
  );

  return {
    vectorYaml,
    dockerfile,
    runCommand,
    envVars,
    selectedCount: sourceRefs.length,
    monitorSummary:
      input.monitors.length === 0
        ? "no monitors yet"
        : `${input.monitors.length} monitor${input.monitors.length === 1 ? "" : "s"} → ${sinkCount} sink${sinkCount === 1 ? "" : "s"}`,
  };
}

function renderVectorYaml(
  connection: ConnectionRef,
  driver: ProviderDriver,
  sources: SourceRef[],
  monitors: GeneratorMonitor[],
  heartbeat: GenerateInput["heartbeat"],
  metrics: GenerateInput["metrics"],
): { vectorYaml: string; sinkEnvVars: BundleEnvVar[] } {
  const lines: string[] = [];
  const sinkEnvVars: BundleEnvVar[] = [];

  lines.push("# Generated by logtura — https://logtura.dev");
  lines.push(`# Connection: ${connection.displayName}`);
  lines.push(`# Provider: ${driver.id}`);
  lines.push(`# Account: ${connection.externalAccountId ?? "unknown"}`);
  lines.push("");
  lines.push("api:");
  lines.push("  enabled: true");
  lines.push('  address: "0.0.0.0:8686"');
  lines.push("");

  // ---- sources -----------------------------------------------------
  lines.push("sources:");
  const sourceKeys: string[] = [];
  // Per-source normalize transforms collected here, emitted into the
  // transforms section below. Output keys (post-normalize) feed into
  // tag_source so downstream filters see the uniform shape.
  const normalizeBlocks: Array<{ key: string; yaml: string }> = [];
  const downstreamInputKeys: string[] = [];
  if (sources.length === 0) {
    lines.push(
      "  # No sources selected — pipeline runs with heartbeat only.",
    );
  } else {
    for (const s of sources) {
      const block = driver.generateSourceBlock({ source: s, connection });
      lines.push(`  ${block.key}:`);
      lines.push(block.yaml);
      sourceKeys.push(block.key);
      if (block.normalize) {
        normalizeBlocks.push(block.normalize);
        downstreamInputKeys.push(block.normalize.key);
      } else {
        downstreamInputKeys.push(block.key);
      }
    }
  }
  lines.push("  internal_metrics:");
  lines.push("    type: internal_metrics");
  lines.push("    scrape_interval_secs: 30");
  // Heartbeat pulse — emitted every 30s. Independent of the log
  // pipeline so it keeps firing even when no log events are flowing,
  // which is exactly when we want the dashboard to know the
  // forwarder is still alive.
  if (heartbeat?.kind === "logtura") {
    lines.push("  heartbeat_pulse:");
    lines.push("    type: exec");
    // mode: scheduled — Vector spawns the command on an interval,
    // reads its full stdout, then waits for the next tick. No
    // long-running shell loop, no stdout buffering to fight: the
    // process terminates between heartbeats, so all output is
    // flushed by definition. (mode: streaming with a `while true`
    // loop hits glibc's fully-buffered-when-piped default — only the
    // first \n flushes opportunistically; everything after sits in
    // a 4 KB buffer that never fills.)
    lines.push(
      `    command: ["printf", "%s\\\\n", "{\\\"deployment_id\\\":\\\"${heartbeat.deploymentId}\\\"}"]`,
    );
    lines.push("    mode: scheduled");
    lines.push("    scheduled:");
    lines.push("      exec_interval_secs: 30");
    lines.push("    decoding:");
    lines.push("      codec: json");
  }
  lines.push("");

  // ---- transforms --------------------------------------------------
  // Buffer here so we can suppress the `transforms:` section
  // entirely when there's nothing to emit (no sources → no normalize
  // / tag_source / monitor filters). Vector rejects a bare
  // `transforms:` with no body as "expected any valid TOML value".
  const transformLines: string[] = [];
  // Normalize transforms (per-source) come first so tag_source reads
  // from the post-normalize keys.
  for (const n of normalizeBlocks) {
    transformLines.push(`  ${n.key}:`);
    transformLines.push(n.yaml);
    transformLines.push("");
  }
  if (downstreamInputKeys.length > 0) {
    transformLines.push("  tag_source:");
    transformLines.push("    type: remap");
    transformLines.push(
      `    inputs: [${downstreamInputKeys.map((k) => `"${k}"`).join(", ")}]`,
    );
    transformLines.push("    source: |-");
    transformLines.push(`      .logtura_connection_id = "${connection.id}"`);
    transformLines.push(`      .logtura_provider = "${driver.id}"`);
    transformLines.push("      .logtura_received_at = now()");
    transformLines.push("");
  }

  const upstreamForSinks =
    downstreamInputKeys.length > 0 ? ["tag_source"] : [];

  // Per-monitor filter-step transforms. A monitor with no steps acts
  // as a passthrough (its sinks see everything from tag_source).
  const monitorOutputKeys = new Map<string, string>();
  for (const m of monitors) {
    if (m.monitor.enabled !== 1) continue;
    if (upstreamForSinks.length === 0) continue;
    const steps = parseFilterSteps(m.monitor.filter_steps_json);
    const { transforms, outputKey } = renderStepTransforms(
      steps,
      "tag_source",
      `monitor_${safeKey(m.monitor.id)}`,
    );
    for (const t of transforms) {
      transformLines.push(`  ${t.key}:`);
      transformLines.push(t.yaml);
      transformLines.push("");
    }
    monitorOutputKeys.set(m.monitor.id, outputKey);
  }

  // Per-sink filter-step transforms + destination pre-sink transforms.
  // Env vars are named per *destination* (not per sink): two sinks
  // routing to the same Slack channel share LOGTURA_DEST_SLACK_*_URL
  // and we only emit it once. Names come from the destination's
  // display name so the docker run command is readable.
  const sinkSinkKeys: Array<{ sinkKey: string; yaml: string }> = [];
  const destEnvVarByDestId = new Map<string, string>();
  const usedEnvNames = new Set<string>();
  for (const m of monitors) {
    if (m.monitor.enabled !== 1) continue;
    const monitorOutputKey = monitorOutputKeys.get(m.monitor.id);
    if (!monitorOutputKey) continue;
    for (const sinkSpec of m.sinks) {
      const dDriver = getDestinationDriver(sinkSpec.destination.kind);
      if (!dDriver) continue;

      // Resolve (or assign) the env var name for this destination.
      // First sink for a given destination registers + adds the env
      // var entry; subsequent sinks reuse the name.
      let envVarName = destEnvVarByDestId.get(sinkSpec.destination.id);
      if (!envVarName) {
        const base = baseDestEnvName(sinkSpec.destination.display_name);
        envVarName = uniquify(base, usedEnvNames);
        usedEnvNames.add(envVarName);
        destEnvVarByDestId.set(sinkSpec.destination.id, envVarName);
        const envSpec = dDriver.runtimeEnvVars({
          config: sinkSpec.destinationConfig,
          envVarName,
          displayName: sinkSpec.destination.display_name,
        });
        for (const e of envSpec) {
          sinkEnvVars.push({
            name: e.name,
            description: e.description,
            source: "destination",
            value: dDriver.envVarValue(sinkSpec.destinationConfig, e.name),
          });
        }
      }

      const sinkSteps = parseFilterSteps(sinkSpec.sink.filter_steps_json);
      const { transforms, outputKey } = renderStepTransforms(
        sinkSteps,
        monitorOutputKey,
        `sink_${safeKey(sinkSpec.sink.id)}`,
      );
      for (const t of transforms) {
        transformLines.push(`  ${t.key}:`);
        transformLines.push(t.yaml);
        transformLines.push("");
      }
      const sinkKey = `sink_${safeKey(sinkSpec.sink.id)}`;
      const bundle = dDriver.generateSinkBundle({
        config: sinkSpec.destinationConfig,
        inputs: [outputKey],
        sinkKey,
        envVarName,
      });
      for (const t of bundle.preSinkTransforms ?? []) {
        transformLines.push(`  ${t.key}:`);
        transformLines.push(t.yaml);
        transformLines.push("");
      }
      sinkSinkKeys.push({ sinkKey: bundle.sink.key, yaml: bundle.sink.yaml });
    }
  }

  // Only emit the transforms section if we actually have transforms.
  // Bare `transforms:` is invalid YAML in Vector's eyes.
  if (transformLines.length > 0) {
    lines.push("transforms:");
    for (const line of transformLines) lines.push(line);
  }

  // ---- sinks --------------------------------------------------------
  lines.push("sinks:");
  for (const ss of sinkSinkKeys) {
    lines.push(`  ${ss.sinkKey}:`);
    lines.push(ss.yaml);
    lines.push("");
  }
  if (sinkSinkKeys.length === 0 && sourceKeys.length > 0) {
    // No destinations configured yet — emit stdout so the pipeline
    // is still valid. The user gets unstructured output until they
    // wire up a destination.
    lines.push("  stdout:");
    lines.push("    type: console");
    lines.push('    inputs: ["tag_source"]');
    lines.push("    encoding:");
    lines.push("      codec: json");
    lines.push("");
  }
  lines.push("  prom_heartbeat:");
  lines.push("    type: prometheus_exporter");
  lines.push('    inputs: ["internal_metrics"]');
  lines.push('    address: "0.0.0.0:9598"');
  lines.push("");

  if (heartbeat?.kind === "logtura") {
    lines.push("  heartbeat_logtura:");
    lines.push("    type: http");
    lines.push('    inputs: ["heartbeat_pulse"]');
    lines.push('    uri: "${LOGTURA_HEARTBEAT_URL}"');
    lines.push("    method: post");
    lines.push("    encoding:");
    lines.push("      codec: json");
    lines.push("    request:");
    lines.push("      headers:");
    lines.push('        authorization: "Bearer ${LOGTURA_HEARTBEAT_TOKEN}"');
    lines.push("        content-type: application/json");
    lines.push("    batch:");
    lines.push("      max_events: 1");
    lines.push("      timeout_secs: 30");
    lines.push("    healthcheck:");
    lines.push("      enabled: false");
    lines.push("");
  }

  // ---- metrics sink (optional) -------------------------------------
  // metrics: logtura → http POST to /api/metrics/:deploymentId.
  // metrics: destination → route internal_metrics through the named
  //   destination's sink driver (datadog_metrics, prometheus_remote_write).
  if (metrics?.kind === "logtura") {
    lines.push("  metrics_logtura:");
    lines.push("    type: http");
    lines.push('    inputs: ["internal_metrics"]');
    lines.push('    uri: "${LOGTURA_METRICS_URL}"');
    lines.push("    method: post");
    lines.push("    encoding:");
    lines.push("      codec: json");
    lines.push("    request:");
    lines.push("      headers:");
    lines.push('        authorization: "Bearer ${LOGTURA_METRICS_TOKEN}"');
    lines.push("        content-type: application/json");
    lines.push("    batch:");
    lines.push("      max_events: 100");
    lines.push("      timeout_secs: 30");
    lines.push("    healthcheck:");
    lines.push("      enabled: false");
    lines.push("");
  }

  if (metrics?.kind === "destination") {
    const m = metrics;
    const dDriver = getDestinationDriver(m.destination.kind);
    if (dDriver && dDriver.flows.includes("metrics")) {
      const envName = baseDestEnvName(m.destination.display_name).replace(
        /_URL$/,
        "_METRICS",
      );
      const sinkKey = `metrics_${safeKey(m.destination.id)}`;
      const bundle = dDriver.generateSinkBundle({
        config: m.destinationConfig,
        inputs: ["internal_metrics"],
        sinkKey,
        envVarName: envName,
      });
      for (const t of bundle.preSinkTransforms ?? []) {
        lines.push(`  ${t.key}:`);
        lines.push(t.yaml);
        lines.push("");
      }
      lines.push(`  ${bundle.sink.key}:`);
      lines.push(bundle.sink.yaml);
      lines.push("");
    }
  }

  return { vectorYaml: lines.join("\n"), sinkEnvVars };
}

/**
 * Render Vector transforms for a chain of filter steps. Each step
 * becomes a transform that takes the previous one's output as input;
 * an empty step list is a pass-through (the inputKey is returned
 * unchanged with no transforms emitted).
 */
function renderStepTransforms(
  steps: FilterStep[],
  inputKey: string,
  prefix: string,
): { transforms: Array<{ key: string; yaml: string }>; outputKey: string } {
  const transforms: Array<{ key: string; yaml: string }> = [];
  let current = inputKey;
  steps.forEach((step, idx) => {
    // Rollup is special: needs 3 chained transforms (pre-remap +
    // reduce + post-remap) instead of one. All other step kinds
    // collapse to a single transform via renderStepYaml.
    if (step.kind === "rollup") {
      const stages = renderRollupStages(step, current, `${prefix}_${idx}`);
      for (const s of stages) {
        transforms.push(s);
        current = s.key;
      }
      return;
    }
    const key = `${prefix}_${idx}_${step.kind}`;
    const yaml = renderStepYaml(step, current);
    if (!yaml) return;
    transforms.push({ key, yaml });
    current = key;
  });
  return { transforms, outputKey: current };
}

/** Emit the three transforms a "rollup" step compiles to:
 *
 *   prefix_idx_rollup_pre   — remap: add count=1 and sample=.message
 *   prefix_idx_rollup_reduce — reduce: group + sum count +
 *                              flat_unique sample (so 140k identical
 *                              messages collapse to one in the array
 *                              before we render the summary, not
 *                              after — memory-bounded by unique
 *                              message count, not by event count)
 *   prefix_idx_rollup_fmt    — remap: render `.message` as a human
 *                              summary "N events in Ws; M unique
 *                              samples: a | b | c"
 *
 * Post-rollup events have .error=true / .level=error so an upstream
 * Errors filter further downstream still routes them.
 */
function renderRollupStages(
  step: { window_secs: number; group_by?: string[]; max_samples?: number },
  input: string,
  prefix: string,
): Array<{ key: string; yaml: string }> {
  const windowSecs = Math.max(1, Math.floor(step.window_secs));
  const windowMs = windowSecs * 1000;
  const groupBy = step.group_by ?? [];
  const maxSamples = Math.max(1, Math.min(50, step.max_samples ?? 5));

  const preKey = `${prefix}_rollup_pre`;
  const reduceKey = `${prefix}_rollup_reduce`;
  const fmtKey = `${prefix}_rollup_fmt`;

  const preYaml = [
    "    type: remap",
    `    inputs: ["${input}"]`,
    "    source: |-",
    `      .count = 1`,
    `      .sample = string(.message) ?? encode_json(.)`,
  ].join("\n");

  const groupByYaml =
    groupBy.length > 0
      ? `    group_by: [${groupBy.map((g) => `"${g}"`).join(", ")}]`
      : `    group_by: []`;
  const reduceYaml = [
    "    type: reduce",
    `    inputs: ["${preKey}"]`,
    `    expire_after_ms: ${windowMs}`,
    `    flush_period_ms: ${windowMs}`,
    groupByYaml,
    "    merge_strategies:",
    "      count: sum",
    "      sample: flat_unique",
  ].join("\n");

  const fmtYaml = [
    "    type: remap",
    `    inputs: ["${reduceKey}"]`,
    "    source: |-",
    `      samples = array(.sample) ?? []`,
    `      unique_count = length(samples)`,
    `      top = slice!(samples, 0, ${maxSamples})`,
    `      top_str = join!(top, " | ")`,
    `      n = int(.count) ?? 0`,
    `      window_label = "${windowSecs}s"`,
    `      header = string(n) + " events in " + window_label`,
    `      tail = if unique_count > length(top) { " (" + string(unique_count) + " unique, top " + string(length(top)) + ")" } else { "" }`,
    `      .message = header + tail + " — " + top_str`,
    `      .error = true`,
    `      .level = "error"`,
    `      del(.sample)`,
    `      del(.count)`,
  ].join("\n");

  return [
    { key: preKey, yaml: preYaml },
    { key: reduceKey, yaml: reduceYaml },
    { key: fmtKey, yaml: fmtYaml },
  ];
}

function renderStepYaml(step: FilterStep, input: string): string | null {
  switch (step.kind) {
    case "errors":
      return [
        "    type: filter",
        `    inputs: ["${input}"]`,
        "    condition: |-",
        `      (bool(.error) ?? false) || (string(.level) ?? "") == "error"`,
      ].join("\n");
    case "level": {
      const op = step.mode === "exclude" ? "!=" : "==";
      return [
        "    type: filter",
        `    inputs: ["${input}"]`,
        "    condition: |-",
        `      (string(.level) ?? "") ${op} ${JSON.stringify(step.level)}`,
      ].join("\n");
    }
    case "match": {
      const field = step.field ?? "message";
      const safePattern = step.pattern.replace(/'/g, "");
      const matches = `match(string(.${field}) ?? "", r'${safePattern}') ?? false`;
      const cond = step.mode === "exclude" ? `!(${matches})` : matches;
      return [
        "    type: filter",
        `    inputs: ["${input}"]`,
        "    condition: |-",
        `      ${cond}`,
      ].join("\n");
    }
    case "rate_limit":
      return [
        "    type: throttle",
        `    inputs: ["${input}"]`,
        `    threshold: ${step.per_minute}`,
        `    window_secs: 60`,
      ].join("\n");
    case "dedup": {
      const fields = step.fields ?? ["message"];
      return [
        "    type: dedupe",
        `    inputs: ["${input}"]`,
        "    cache:",
        "      num_events: 5000",
        "    fields:",
        "      match:",
        ...fields.map((f) => `        - "${f}"`),
      ].join("\n");
    }
    case "sample": {
      // Vector sample.rate keeps 1 in N. Convert fraction → N.
      const rate = Math.max(1, Math.round(1 / Math.max(0.0001, step.rate)));
      return [
        "    type: sample",
        `    inputs: ["${input}"]`,
        `    rate: ${rate}`,
      ].join("\n");
    }
  }
  return null;
}

function renderDockerfile(deps: DockerfileDep[]): string {
  const aptPackages = new Set<string>();
  for (const d of deps) {
    for (const p of d.aptPackages ?? []) aptPackages.add(p);
  }
  const aptList = [...aptPackages].sort().join(" ");
  const installSteps = deps.map((d) => `RUN ${d.install}`).join("\n");

  return `# Generated by logtura — https://logtura.dev
# Vector-based forwarder. Tails selected log sources and routes them
# through monitors to your configured destinations.

FROM timberio/vector:latest-debian

${aptList ? `RUN apt-get update && apt-get install -y --no-install-recommends ${aptList} && rm -rf /var/lib/apt/lists/*` : ""}
${installSteps}

COPY vector.yaml /etc/vector/vector.yaml

# Heartbeat (Prometheus exporter) — scrape from your monitoring stack.
EXPOSE 9598
# Vector API (vector top, debugging).
EXPOSE 8686

CMD ["vector", "--config", "/etc/vector/vector.yaml"]
`;
}

function renderRunCommand(envVars: BundleEnvVar[]): string {
  const flags = envVars.map((v) => {
    const placeholder =
      v.value !== null ? v.value : `<${v.name.toLowerCase()}>`;
    return `  -e ${v.name}="${placeholder}"`;
  });
  return [
    "docker build -t logtura-forwarder .",
    "",
    "docker run --rm \\",
    `${flags.join(" \\\n")} \\`,
    "  logtura-forwarder",
  ].join("\n");
}

// --- helpers ------------------------------------------------------

function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Build the readable env-var name for a destination from its display
 *  name. "Slack #alerts" → "LOGTURA_DEST_SLACK_ALERTS_URL". Falls back
 *  to "LOGTURA_DEST_DEST_URL" if the display name has no usable
 *  characters. */
function baseDestEnvName(displayName: string): string {
  const core = displayName
    .normalize("NFKD")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `LOGTURA_DEST_${core || "DEST"}_URL`;
}

/** Append a numeric suffix if a name is already taken, so two
 *  destinations sharing a sanitized display name still get unique
 *  env vars. */
function uniquify(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  for (let i = 2; i < 1000; i++) {
    const candidate = name.replace(/_URL$/, `_${i}_URL`);
    if (!used.has(candidate)) return candidate;
  }
  return `${name}_${Date.now()}`;
}
