#!/usr/bin/env node
/**
 * Run Vector's own config validator against representative bundles
 * the generator produces, so VRL syntax errors (E651, type errors,
 * missing fns, etc.) get caught before deploy. Every transform —
 * including all the cloudflare normalize remaps and the rollup
 * reduce + format remaps — gets checked.
 *
 * Why a script and not vitest: this isn't a JS unit test, it's a
 * black-box check that the generated YAML loads. The validator is
 * `vector --config <file> validate`, which we run inside our
 * forwarder image to get the exact same Vector binary the deploy
 * uses.
 *
 * Run:    pnpm test:vector
 * CI:     .github/workflows/test-vector-config.yml
 *
 * Exit 0 on all pass, non-zero on any fixture failing.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const FORWARDER_IMAGE = "ghcr.io/q32llc/logtura-forwarder:latest";

// Use tsx-style import for our TS sources. Node 24 supports
// --experimental-strip-types so we can load .ts directly.
const { generateBundle } = await import(
  resolve(projectRoot, "src/generator.ts")
);

// --- Fixtures ----------------------------------------------------
//
// Each fixture exercises a different shape of the generated yaml.
// New shapes (new filter steps, destinations, providers) should
// land here.

const CF_CONNECTION = {
  id: "con_test",
  user_id: "usr_test",
  provider: "cloudflare",
  display_name: "test cloudflare",
  external_account_id: "f0c6ed442ab8c6bf9d102678d9421dd8",
  credentials_encrypted: new ArrayBuffer(0),
  created_at: 0,
  updated_at: 0,
  last_discovered_at: null,
};

const CF_SOURCES = [
  {
    id: "src_w1",
    connection_id: "con_test",
    source_kind: "cf_worker",
    source_kind_label: "Worker",
    external_id: "my-worker",
    display_name: "my-worker",
    metadata_json: null,
    discovered_at: 0,
  },
  {
    id: "src_w2",
    connection_id: "con_test",
    source_kind: "cf_worker",
    source_kind_label: "Worker",
    external_id: "other-worker",
    display_name: "other-worker",
    metadata_json: null,
    discovered_at: 0,
  },
  {
    id: "src_ai1",
    connection_id: "con_test",
    source_kind: "cf_ai_gateway",
    source_kind_label: "AI Gateway",
    external_id: "my-gateway",
    display_name: "my-gateway",
    metadata_json: null,
    discovered_at: 0,
  },
];

const FLY_CONNECTION = {
  id: "con_fly",
  user_id: "usr_test",
  provider: "fly",
  display_name: "test fly",
  external_account_id: "personal",
  credentials_encrypted: new ArrayBuffer(0),
  created_at: 0,
  updated_at: 0,
  last_discovered_at: null,
};

const FLY_SOURCES = [
  {
    id: "src_fly1",
    connection_id: "con_fly",
    source_kind: "fly_app",
    source_kind_label: "App",
    external_id: "my-app",
    display_name: "my-app",
    metadata_json: null,
    discovered_at: 0,
  },
  {
    id: "src_fly2",
    connection_id: "con_fly",
    source_kind: "fly_app",
    source_kind_label: "App",
    external_id: "other-app",
    display_name: "other-app",
    metadata_json: null,
    discovered_at: 0,
  },
];

const SLACK_DEST = {
  id: "dest_slack",
  user_id: "usr_test",
  kind: "slack",
  display_name: "alerts",
  config_encrypted: new ArrayBuffer(0),
  created_at: 0,
  updated_at: 0,
};

const SLACK_CONFIG = {
  webhookUrl: "https://hooks.slack.com/services/T00/B00/XXX",
  teamName: "q32",
  channel: "alerts",
};

const WEBHOOK_DEST = {
  id: "dest_webhook",
  user_id: "usr_test",
  kind: "webhook",
  display_name: "ops bridge",
  config_encrypted: new ArrayBuffer(0),
  created_at: 0,
  updated_at: 0,
};
const WEBHOOK_CONFIG = { url: "https://example.com/hook" };

const DD_METRICS_DEST = {
  id: "dest_dd",
  user_id: "usr_test",
  kind: "datadog_metrics",
  display_name: "datadog",
  config_encrypted: new ArrayBuffer(0),
  created_at: 0,
  updated_at: 0,
};
const DD_METRICS_CONFIG = {
  apiKey: "xxxx-xxxx-xxxx",
  site: "datadoghq.com",
};

function monitorWithSteps(id, filterSteps, sinks = []) {
  return {
    monitor: {
      id,
      user_id: "usr_test",
      connection_id: null,
      display_name: id,
      filter_steps_json: JSON.stringify(filterSteps),
      enabled: 1,
      created_at: 0,
      updated_at: 0,
    },
    sinks,
  };
}

function sinkWith(id, destination, destinationConfig, filterSteps) {
  return {
    sink: {
      id,
      monitor_id: "ignored",
      destination_id: destination.id,
      filter_steps_json: JSON.stringify(filterSteps),
      created_at: 0,
    },
    destination,
    destinationConfig,
  };
}

const FIXTURES = [
  {
    name: "cf-default-errors-rollup",
    desc: "Cloudflare + default errors+rollup monitor → Slack sink + heartbeat + metrics-to-logtura",
    input: {
      connection: CF_CONNECTION,
      selectedSources: CF_SOURCES,
      monitors: [
        monitorWithSteps(
          "mon_errors",
          [
            { kind: "errors" },
            {
              kind: "rollup",
              window_secs: 30,
              group_by: ["script"],
              max_samples: 5,
            },
          ],
          [
            sinkWith("snk_slack", SLACK_DEST, SLACK_CONFIG, [
              { kind: "dedup", window_secs: 300, fields: ["message"] },
            ]),
          ],
        ),
      ],
      heartbeat: {
        kind: "logtura",
        deploymentId: "dep_test",
        appUrl: "https://logtura.example.com",
      },
      metrics: {
        kind: "logtura",
        deploymentId: "dep_test",
        appUrl: "https://logtura.example.com",
      },
    },
  },
  {
    name: "cf-all-filter-kinds",
    desc: "every filter step kind exercised in one monitor",
    input: {
      connection: CF_CONNECTION,
      selectedSources: CF_SOURCES,
      monitors: [
        monitorWithSteps(
          "mon_kitchen",
          [
            { kind: "errors" },
            {
              kind: "match",
              pattern: "timeout|refused",
              mode: "include",
              field: "message",
            },
            { kind: "level", level: "warn", mode: "include" },
            { kind: "rate_limit", per_minute: 120 },
            { kind: "sample", rate: 0.5 },
            { kind: "dedup", window_secs: 60, fields: ["message", "script"] },
            {
              kind: "rollup",
              window_secs: 10,
              group_by: [],
              max_samples: 3,
            },
          ],
          [sinkWith("snk_webhook", WEBHOOK_DEST, WEBHOOK_CONFIG, [])],
        ),
      ],
      heartbeat: { kind: "none" },
      metrics: { kind: "none" },
    },
  },
  {
    name: "cf-metrics-to-datadog",
    desc: "metrics routed through a datadog_metrics destination",
    input: {
      connection: CF_CONNECTION,
      selectedSources: CF_SOURCES.slice(0, 1),
      monitors: [],
      heartbeat: { kind: "none" },
      metrics: {
        kind: "destination",
        destination: DD_METRICS_DEST,
        destinationConfig: DD_METRICS_CONFIG,
      },
    },
  },
  {
    name: "cf-no-sources-still-valid",
    desc: "zero selected sources — heartbeat-only pipeline; should still be a valid config",
    input: {
      connection: CF_CONNECTION,
      selectedSources: [],
      monitors: [],
      heartbeat: {
        kind: "logtura",
        deploymentId: "dep_test",
        appUrl: "https://logtura.example.com",
      },
      metrics: { kind: "none" },
    },
  },
  {
    name: "fly-two-apps",
    desc: "Fly source provider: exec command + jq pipeline shouldn't trip Vector's $VAR pre-pass on the jq filter",
    input: {
      connection: FLY_CONNECTION,
      selectedSources: FLY_SOURCES,
      monitors: [
        monitorWithSteps(
          "mon_fly_errors",
          [{ kind: "errors" }],
          [sinkWith("snk_webhook", WEBHOOK_DEST, WEBHOOK_CONFIG, [])],
        ),
      ],
      heartbeat: { kind: "none" },
      metrics: { kind: "none" },
    },
  },
];

// --- Runner ------------------------------------------------------

let failed = 0;
const tmpRoot = mkdtempSync(join(tmpdir(), "logtura-vec-test-"));
console.log(`Validating ${FIXTURES.length} fixture(s)`);

for (const fx of FIXTURES) {
  const dir = join(tmpRoot, fx.name);
  mkdirSync(dir, { recursive: true });
  let bundle;
  try {
    // Fixtures use the historic single-connection shape; adapt to
    // the multi-connection API the generator now expects without
    // rewriting every fixture.
    const input = fx.input.connections
      ? fx.input
      : {
          ...fx.input,
          connections: [
            {
              connection: fx.input.connection,
              selectedSources: fx.input.selectedSources,
              credentials: fx.input.connectionCredentials,
            },
          ],
        };
    bundle = generateBundle(input);
  } catch (e) {
    console.error(`✗ ${fx.name}: generateBundle threw —`, e instanceof Error ? e.message : e);
    failed++;
    continue;
  }
  writeFileSync(join(dir, "vector.yaml"), bundle.vectorYaml);

  // Build a .env where every required key has a benign placeholder
  // value, so Vector's `${VAR}` interpolation succeeds during
  // --validate.
  const envLines = bundle.envVars.map((v) => `${v.name}=placeholder_value`);
  writeFileSync(join(dir, ".env"), envLines.join("\n"));

  // IMPORTANT: do NOT pass --no-environment. The flag is named
  // confusingly: it disables "environment checks" which Vector
  // defines to include component compilation — so VRL transforms
  // are never actually built, and every E103/E651/E701 slips
  // through. We pass --skip-healthchecks instead so we don't try to
  // hit Slack/Cloudflare from CI, but we DO want the VRL compile
  // pass, which is the entire point of this script.
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--env-file",
      join(dir, ".env"),
      "-v",
      `${join(dir, "vector.yaml")}:/etc/vector/vector.yaml`,
      "--entrypoint",
      "/usr/bin/vector",
      FORWARDER_IMAGE,
      "validate",
      "--skip-healthchecks",
      "/etc/vector/vector.yaml",
    ],
    { encoding: "utf8" },
  );

  if (result.status === 0) {
    console.log(`✓ ${fx.name}`);
  } else {
    failed++;
    console.error(`✗ ${fx.name} (${fx.desc})`);
    const err = (result.stderr || result.stdout || "").trim();
    for (const line of err.split("\n").slice(0, 40)) {
      console.error(`    ${line}`);
    }
    // Leave the failing fixture's tmp dir around for hand-inspection.
    console.error(`    yaml: ${join(dir, "vector.yaml")}`);
    fx.keep = true;
  }
}

// Clean up successful fixtures only.
for (const fx of FIXTURES) {
  if (!fx.keep) {
    rmSync(join(tmpRoot, fx.name), { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} fixture(s) failed`);
  process.exit(1);
}
console.log("All fixtures pass");
