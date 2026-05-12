import type {
  BundleEnvVar,
  ComponentManifestEntry,
  Connection,
  ConnectionRef,
  Destination,
  DestinationDriver,
  DockerfileDep,
  DriverPipeline,
  EnvVarSpec,
  FilterStep,
  GeneratedBundle,
  GenerateInput,
  GeneratorConnection,
  GeneratorMonitor,
  ProviderDriver,
  ProviderSelection,
  Source,
  SourceRef,
} from "./types";

export function generateBundle(input: GenerateInput): GeneratedBundle {
  if (input.connections.length === 0) {
    throw new Error("generateBundle requires at least one connection");
  }
  // Driver lookups are scoped to this call. `input.providers` and
  // `input.destinations` are the registry. No global state, no
  // implicit side-effects.
  const providerById = new Map(input.providers.map((p) => [p.id, p]));
  const destinationById = new Map(
    input.destinations.map((d) => [d.id, d]),
  );
  const getProvider = (id: string): ProviderDriver | null =>
    providerById.get(id) ?? null;
  const getDestinationDriver = (id: string): DestinationDriver | null =>
    destinationById.get(id) ?? null;

  // Resolve drivers + refs per connection, then immediately ask each
  // driver to render its complete sub-pipeline. The driver owns its
  // component layout end-to-end; the renderer just stitches the
  // sub-pipelines together with downstream tagging / filtering /
  // sinks.
  const resolved = input.connections.map((c) => {
    const driver = getProvider(c.connection.provider);
    if (!driver) {
      throw new Error(`Unknown provider: ${c.connection.provider}`);
    }
    const connectionRef: ConnectionRef = {
      id: c.connection.id,
      externalAccountId: c.connection.externalAccountId,
      displayName: c.connection.displayName,
    };
    const sources: SourceRef[] = c.selectedSources.map((s) => ({
      id: s.id,
      externalId: s.externalId,
      displayName: s.displayName,
      sourceKind: s.sourceKind,
      metadata: s.metadata,
    }));
    const selection: ProviderSelection = c.selectAll
      ? { kind: "all" }
      : { kind: "list", sources };
    if (
      selection.kind === "all" &&
      driver.capabilities.selection === "list"
    ) {
      throw new Error(
        `Driver ${driver.id} does not support "all" selection; pick sources explicitly or pick a different driver`,
      );
    }
    const pipeline = driver.generatePipeline({
      connection: connectionRef,
      selection,
    });
    return {
      raw: c,
      connectionRef,
      driver,
      sources,
      sourceRows: c.selectedSources,
      pipeline,
    };
  });

  const { vectorYaml, sinkEnvVars, componentManifest } = renderVectorYaml(
    resolved,
    input.monitors,
    input.heartbeat,
    input.metrics,
    getDestinationDriver,
  );

  // Aggregate Dockerfile deps + env vars contributed by each
  // connection's pipeline. Dedup env vars by name; with one driver
  // per connection a same-named var across connections (eg two CF
  // accounts both wanting CLOUDFLARE_API_TOKEN) collapses to one
  // entry. First-write-wins, which matches what the forwarder
  // image's single env exposes anyway.
  const dockerDeps = resolved.flatMap((r) => r.pipeline.dockerfileDeps);
  const dockerfile = renderDockerfile(dockerDeps);

  const seenEnv = new Set<string>();
  const envVars: BundleEnvVar[] = [];
  for (const r of resolved) {
    for (const e of r.pipeline.envVars) {
      if (seenEnv.has(e.name)) continue;
      seenEnv.add(e.name);
      let value: string | null = null;
      if (e.source === "external_account_id") {
        value = r.raw.connection.externalAccountId ?? null;
      } else if (
        e.source === "credential" &&
        e.credentialPath &&
        r.raw.credentials
      ) {
        const v = r.raw.credentials[e.credentialPath];
        if (typeof v === "string") value = v;
      }
      envVars.push({
        name: e.name,
        description: e.description,
        source: e.source,
        value,
        helpUrl: e.helpUrl,
      });
    }
  }
  envVars.push(...sinkEnvVars);

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
      const envName = baseDestEnvName(m.destination.displayName).replace(
        /_URL$/,
        "_METRICS",
      );
      for (const e of dDriver.runtimeEnvVars({
        config: m.destinationConfig,
        envVarName: envName,
        displayName: m.destination.displayName,
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
    selectedCount: resolved.reduce((n, r) => n + r.sources.length, 0),
    monitorSummary:
      input.monitors.length === 0
        ? "no monitors yet"
        : `${input.monitors.length} monitor${input.monitors.length === 1 ? "" : "s"} → ${sinkCount} sink${sinkCount === 1 ? "" : "s"}`,
    componentManifest,
  };
}

interface ResolvedConnection {
  raw: GeneratorConnection;
  connectionRef: ConnectionRef;
  driver: ProviderDriver;
  sources: SourceRef[];
  sourceRows: Source[];
  pipeline: DriverPipeline;
}

function renderVectorYaml(
  resolved: ResolvedConnection[],
  monitors: GeneratorMonitor[],
  heartbeat: GenerateInput["heartbeat"],
  metrics: GenerateInput["metrics"],
  getDestinationDriver: (id: string) => DestinationDriver | null,
): {
  vectorYaml: string;
  sinkEnvVars: BundleEnvVar[];
  componentManifest: ComponentManifestEntry[];
} {
  const lines: string[] = [];
  const sinkEnvVars: BundleEnvVar[] = [];
  const componentManifest: ComponentManifestEntry[] = [];

  lines.push("# Generated by logtura — https://logtura.dev");
  for (const r of resolved) {
    lines.push(
      `# Connection: ${r.connectionRef.displayName} (provider: ${r.driver.id}, account: ${r.connectionRef.externalAccountId ?? "unknown"})`,
    );
  }
  lines.push("");
  lines.push("api:");
  lines.push("  enabled: true");
  lines.push('  address: "0.0.0.0:8686"');
  lines.push("");

  // Render the source-side of the bundle:
  //   - For each connection, the driver returned its own complete
  //     sub-pipeline (one or more Vector components + an outputKey).
  //     We dump the source-kind components under `sources:` and the
  //     transform-kind components under `transforms:` later. We
  //     don't iterate per-source or wire normalize transforms; the
  //     driver did all that internally.
  //   - Downstream wiring keys off `pipeline.outputKey` per
  //     connection. Each connection's outputKey feeds its own
  //     tag_conn_<id>, which feeds tag_received, which feeds the
  //     monitor / sink chains.
  const driverTransforms: Array<{ key: string; yaml: string }> = [];
  // Per-connection: the output key the driver said to read from. If
  // a connection has zero components (e.g. a driver that accepted an
  // empty selection) we skip its tag_conn entirely.
  const connectionOutputKey = new Map<string, string>();
  lines.push("sources:");
  const totalSources = resolved.reduce((n, r) => n + r.sources.length, 0);
  let anySourceComponent = false;
  for (const r of resolved) {
    if (r.pipeline.components.length === 0) continue;
    connectionOutputKey.set(r.connectionRef.id, r.pipeline.outputKey);
    for (const comp of r.pipeline.components) {
      if (comp.kind === "source") {
        lines.push(`  ${comp.key}:`);
        lines.push(comp.yaml);
        anySourceComponent = true;
      } else {
        driverTransforms.push({ key: comp.key, yaml: comp.yaml });
      }
    }
    // Driver-provided manifest entries describe the emitted
    // components. Hosts that display per-component status use these.
    for (const m of r.pipeline.manifest ?? []) {
      componentManifest.push(m);
    }
  }
  if (!anySourceComponent) {
    lines.push(
      "  # No sources selected. Pipeline runs with heartbeat only.",
    );
  }
  lines.push("  internal_metrics:");
  lines.push("    type: internal_metrics");
  lines.push("    scrape_interval_secs: 30");
  componentManifest.push({
    id: "internal_metrics",
    role: "internal_metrics",
    category: "plumbing",
    label: "Vector internal metrics",
  });
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
    componentManifest.push({
      id: "heartbeat_pulse",
      role: "heartbeat",
      category: "plumbing",
      label: "Heartbeat pulse",
      detail: "30s ping generator",
    });
  }
  lines.push("");

  // ---- transforms --------------------------------------------------
  // Order:
  //   1. Driver-provided transform-kind components (one driver
  //      sub-pipeline per connection, all opaque to the renderer).
  //   2. Per-connection tag_conn_<id>. Fans in the driver's
  //      outputKey, sets .logtura_connection_id and
  //      .logtura_provider.
  //   3. Unified tag_received. Fans in every tag_conn output, sets
  //      .logtura_received_at = now(). Single downstream input for
  //      monitors.
  //
  // Buffered so we can suppress the `transforms:` section entirely
  // when there's nothing to emit. Vector rejects a bare `transforms:`
  // with no body.
  const transformLines: string[] = [];
  for (const t of driverTransforms) {
    transformLines.push(`  ${t.key}:`);
    transformLines.push(t.yaml);
    transformLines.push("");
  }

  const tagConnOutputKeys: string[] = [];
  for (const r of resolved) {
    const outputKey = connectionOutputKey.get(r.connectionRef.id);
    if (!outputKey) continue;
    const key = `tag_conn_${safeKey(r.connectionRef.id)}`;
    transformLines.push(`  ${key}:`);
    transformLines.push("    type: remap");
    transformLines.push(`    inputs: ["${outputKey}"]`);
    transformLines.push("    source: |-");
    transformLines.push(`      .logtura_connection_id = "${r.connectionRef.id}"`);
    transformLines.push(`      .logtura_provider = "${r.driver.id}"`);
    transformLines.push("");
    tagConnOutputKeys.push(key);
    componentManifest.push({
      id: key,
      role: "tag_source",
      category: "plumbing",
      label: `Tag · ${r.connectionRef.displayName}`,
      detail: r.driver.id,
      links: { connectionId: r.connectionRef.id },
    });
  }

  if (tagConnOutputKeys.length > 0) {
    transformLines.push("  tag_received:");
    transformLines.push("    type: remap");
    transformLines.push(
      `    inputs: [${tagConnOutputKeys.map((k) => `"${k}"`).join(", ")}]`,
    );
    transformLines.push("    source: |-");
    transformLines.push("      .logtura_received_at = now()");
    transformLines.push("");
    componentManifest.push({
      id: "tag_received",
      role: "tag_source",
      category: "plumbing",
      label: "Tag received-at",
      detail: "Cross-connection merge",
    });
  }

  const upstreamForSinks =
    tagConnOutputKeys.length > 0 ? ["tag_received"] : [];

  // Per-monitor filter-step transforms. A monitor with no steps acts
  // as a passthrough (its sinks see everything from tag_received).
  const monitorOutputKeys = new Map<string, string>();
  for (const m of monitors) {
    if (!m.monitor.enabled) continue;
    if (upstreamForSinks.length === 0) continue;
    const steps = m.monitor.filterSteps;
    const { transforms, outputKey } = renderStepTransforms(
      steps,
      "tag_received",
      `monitor_${safeKey(m.monitor.id)}`,
    );
    for (const t of transforms) {
      transformLines.push(`  ${t.key}:`);
      transformLines.push(t.yaml);
      transformLines.push("");
      componentManifest.push({
        id: t.key,
        role: "monitor_filter",
        category: "plumbing",
        label: `Filter · ${m.monitor.displayName}`,
        detail: t.stepKind,
        links: { monitorId: m.monitor.id },
      });
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
    if (!m.monitor.enabled) continue;
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
        const base = baseDestEnvName(sinkSpec.destination.displayName);
        envVarName = uniquify(base, usedEnvNames);
        usedEnvNames.add(envVarName);
        destEnvVarByDestId.set(sinkSpec.destination.id, envVarName);
        const envSpec = dDriver.runtimeEnvVars({
          config: sinkSpec.destinationConfig,
          envVarName,
          displayName: sinkSpec.destination.displayName,
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

      const sinkSteps = sinkSpec.sink.filterSteps;
      const { transforms, outputKey } = renderStepTransforms(
        sinkSteps,
        monitorOutputKey,
        `sink_${safeKey(sinkSpec.sink.id)}`,
      );
      for (const t of transforms) {
        transformLines.push(`  ${t.key}:`);
        transformLines.push(t.yaml);
        transformLines.push("");
        componentManifest.push({
          id: t.key,
          role: "sink_filter",
          category: "plumbing",
          label: `Pre-sink filter · ${sinkSpec.destination.displayName}`,
          detail: t.stepKind,
          links: {
            sinkId: sinkSpec.sink.id,
            destinationId: sinkSpec.destination.id,
            monitorId: m.monitor.id,
          },
        });
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
        componentManifest.push({
          id: t.key,
          role: "sink_format",
          category: "plumbing",
          label: `Format · ${sinkSpec.destination.displayName}`,
          detail: dDriver.id,
          links: {
            sinkId: sinkSpec.sink.id,
            destinationId: sinkSpec.destination.id,
          },
        });
      }
      sinkSinkKeys.push({ sinkKey: bundle.sink.key, yaml: bundle.sink.yaml });
      componentManifest.push({
        id: bundle.sink.key,
        role: "sink",
        category: "primary",
        label: `${dDriver.displayName} · ${sinkSpec.destination.displayName}`,
        links: {
          sinkId: sinkSpec.sink.id,
          destinationId: sinkSpec.destination.id,
          monitorId: m.monitor.id,
        },
      });
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
  if (sinkSinkKeys.length === 0 && totalSources > 0) {
    // No destinations configured yet — emit stdout so the pipeline
    // is still valid. The user gets unstructured output until they
    // wire up a destination.
    lines.push("  stdout:");
    lines.push("    type: console");
    lines.push('    inputs: ["tag_received"]');
    lines.push("    encoding:");
    lines.push("      codec: json");
    lines.push("");
    componentManifest.push({
      id: "stdout",
      role: "stdout",
      category: "plumbing",
      label: "stdout fallback",
      detail: "no destination configured",
    });
  }
  lines.push("  prom_heartbeat:");
  lines.push("    type: prometheus_exporter");
  lines.push('    inputs: ["internal_metrics"]');
  lines.push('    address: "0.0.0.0:9598"');
  lines.push("");
  componentManifest.push({
    id: "prom_heartbeat",
    role: "prom_exporter",
    category: "plumbing",
    label: "Prometheus exporter",
    detail: ":9598/metrics",
  });

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
    componentManifest.push({
      id: "heartbeat_logtura",
      role: "heartbeat",
      category: "plumbing",
      label: "Heartbeat sink",
      detail: "POSTs to logtura",
    });
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
    componentManifest.push({
      id: "metrics_logtura",
      role: "metrics",
      category: "plumbing",
      label: "Metrics sink",
      detail: "POSTs to logtura",
    });
  }

  if (metrics?.kind === "destination") {
    const m = metrics;
    const dDriver = getDestinationDriver(m.destination.kind);
    if (dDriver && dDriver.flows.includes("metrics")) {
      const envName = baseDestEnvName(m.destination.displayName).replace(
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
      componentManifest.push({
        id: bundle.sink.key,
        role: "metrics",
        category: "plumbing",
        label: `Metrics · ${m.destination.displayName}`,
        detail: dDriver.displayName,
        links: { destinationId: m.destination.id },
      });
    }
  }

  return { vectorYaml: lines.join("\n"), sinkEnvVars, componentManifest };
}

/**
 * Render Vector transforms for a chain of filter steps. Each step
 * becomes a transform that takes the previous one's output as input;
 * an empty step list is a pass-through (the inputKey is returned
 * unchanged with no transforms emitted).
 */
/** A single emitted transform, plus a discriminator describing
 *  which filter step (or rollup stage) it represents — used by the
 *  caller to label component-manifest entries. */
interface RenderedStepTransform {
  key: string;
  yaml: string;
  /** "errors" / "level" / "match" / etc, OR "rollup_pre|reduce|fmt". */
  stepKind: string;
}

function renderStepTransforms(
  steps: FilterStep[],
  inputKey: string,
  prefix: string,
): { transforms: RenderedStepTransform[]; outputKey: string } {
  const transforms: RenderedStepTransform[] = [];
  let current = inputKey;
  steps.forEach((step, idx) => {
    // Rollup is special: needs 3 chained transforms (pre-remap +
    // reduce + post-remap) instead of one. All other step kinds
    // collapse to a single transform via renderStepYaml.
    if (step.kind === "rollup") {
      const stages = renderRollupStages(step, current, `${prefix}_${idx}`);
      for (const s of stages) {
        // Stage key is `${prefix}_${idx}_rollup_<pre|reduce|fmt>`;
        // pull the trailing tag for the manifest.
        const stage = s.key.slice(s.key.lastIndexOf("rollup_"));
        transforms.push({ ...s, stepKind: stage });
        current = s.key;
      }
      return;
    }
    const key = `${prefix}_${idx}_${step.kind}`;
    const yaml = renderStepYaml(step, current);
    if (!yaml) return;
    transforms.push({ key, yaml, stepKind: step.kind });
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

  // NOTE: VRL's `string(x)` is a type-assertion (errors if x isn't
  // string), not a converter. For ints we use `to_string(x)`, which
  // is infallible for primitive types. Getting this wrong yields
  // E103 unhandled-fallible-assignment at runtime and the whole
  // config refuses to load. (vector validate doesn't catch it when
  // run with --no-environment — see scripts/test-vector-config.mjs.)
  // Prefix the rendered message with the group-by key values
  // ("[my-worker]", "[my-worker/iad]", etc.) so the user can tell
  // which source the sample came from. Without this the message is
  // just "14 events in 30s — <sample>" and the recipient has no
  // anchor for "which of my 50 workers is this from."
  //
  // We read each configured group_by field with the same fallibility
  // discipline as the rest of the normalize VRL: string(x) ?? "?"
  // because the field might be a non-string or missing.
  const groupKeyLines =
    groupBy.length === 0
      ? [`      key_label = ""`]
      : [
          `      key_parts = []`,
          ...groupBy.map(
            (f) =>
              `      key_parts = push(key_parts, string(.${f}) ?? "?")`,
          ),
          `      key_label = "[" + join!(key_parts, "/") + "] "`,
        ];
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
    ...groupKeyLines,
    `      header = key_label + to_string(n) + " events in " + window_label`,
    `      tail = if unique_count > length(top) { " (" + to_string(unique_count) + " unique, top " + to_string(length(top)) + ")" } else { "" }`,
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
      // match() is infallible (returns boolean); the inner string()
      // *is* fallible, so its ?? stays. Adding a trailing ?? on the
      // match expression itself trips E651 unnecessary-coalescing.
      const matches = `match(string(.${field}) ?? "", r'${safePattern}')`;
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
