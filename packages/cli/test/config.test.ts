import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateBundle } from "@logtura/core";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  it("compiles friendly YAML into renderer input", () => {
    process.env.CF_TOKEN = "cf_test";
    process.env.CF_ACCOUNT = "acct_test";
    process.env.SLACK_URL = "https://hooks.slack.test/services/x/y/z";

    const parsed = parseConfig(`
sources:
  workers:
    account_id: env:CF_ACCOUNT
    api_token: env:CF_TOKEN
    scripts:
      - dirtsignal
      - ipogrid

sinks:
  slack:
    type: slack
    webhook_url: env:SLACK_URL
    channel: "#alerts"

monitors:
  - name: errors-rollup
    filter:
      - errors
      - rollup:
          window_secs: 30
          group_by: [script]
          max_samples: 5
    sinks: [slack]
`);

    expect(parsed.missingEnv).toEqual([]);
    expect(parsed.input.connections[0]!.connection.provider).toBe(
      "cloudflare-worker-tail",
    );
    expect(parsed.input.connections[0]!.selectedSources).toHaveLength(2);

    const bundle = generateBundle(parsed.input);
    expect(bundle.vectorYaml).toContain("logtura-cf-tail");
    expect(bundle.vectorYaml).toContain("rollup_fmt");
    expect(bundle.envVars.find((v) => v.name === "CLOUDFLARE_API_TOKEN")?.value)
      .toBe("cf_test");
    expect(bundle.envVars.some((v) => v.name.includes("SLACK"))).toBe(true);
  });

  it("parses Slack max_message_chars", () => {
    const parsed = parseConfig(`
sources:
  workers:
    account_id: acct_test
    api_token: token_test
    scripts: [dirtsignal]

sinks:
  slack:
    type: slack
    webhook_url: https://hooks.slack.test/services/x/y/z
    max_message_chars: 4096

monitors:
  - name: errors
    filter: [errors]
    sinks: [slack]
`);

    const config = parsed.input.monitors[0]!.sinks[0]!.destinationConfig as {
      maxMessageChars?: number | null;
    };
    expect(config.maxMessageChars).toBe(4096);
  });

  it("parses Slack maxMessageChars null as no truncation", () => {
    const parsed = parseConfig(`
sources:
  workers:
    account_id: acct_test
    api_token: token_test
    scripts: [dirtsignal]

sinks:
  slack:
    type: slack
    webhook_url: https://hooks.slack.test/services/x/y/z
    maxMessageChars: null

monitors:
  - name: errors
    filter: [errors]
    sinks: [slack]
`);

    const config = parsed.input.monitors[0]!.sinks[0]!.destinationConfig as {
      maxMessageChars?: number | null;
    };
    expect(config.maxMessageChars).toBeNull();
  });

  it("parses custom-vector source and sink includes", () => {
    const dir = mkdtempSync(join(tmpdir(), "logtura-custom-vector-"));
    mkdirSync(join(dir, "vector"));
    writeFileSync(
      join(dir, "vector", "bob.yaml"),
      `
sources:
  bob_http:
    type: http_server
    address: 0.0.0.0:9000
    decoding:
      codec: json
transforms:
  bob_norm:
    type: remap
    inputs: [bob_http]
    source: |
      .message = string(.message) ?? encode_json(.)
      .level = string(.level) ?? "info"
      .error = (bool(.error) ?? false) || .level == "error"
`,
    );
    writeFileSync(
      join(dir, "vector", "joe.yaml"),
      `
sinks:
  joe_sink:
    type: blackhole
    inputs: [joe_in]
    print_interval_secs: 0
`,
    );

    const parsed = parseConfig(
      `
sources:
  bob:
    provider: custom-vector
    display_name: Bob
    vector:
      include: ./vector/bob.yaml
      feed: bob_norm

sinks:
  joe:
    type: custom-vector
    vector:
      include: ./vector/joe.yaml

monitors:
  - name: bob-to-joe
    filter: [errors]
    sinks: [joe]
`,
      join(dir, "logtura.yaml"),
    );

    expect(parsed.input.connections[0]!.connection.provider).toBe(
      "custom-vector",
    );
    expect(parsed.input.monitors[0]!.sinks[0]!.destination.kind).toBe(
      "custom-vector",
    );
    const bundle = generateBundle(parsed.input);
    expect(bundle.vectorYaml).toContain("custom_con_bob_bob_http:");
    expect(bundle.vectorYaml).toContain("custom_con_bob_bob_norm:");
    expect(bundle.vectorYaml).toContain("custom_sink_snk_bob_to_joe_joe_joe_sink:");
    expect(bundle.vectorYaml).toContain("- monitor_mon_bob_to_joe_0_errors");
  });

  it("parses Vercel Runtime Logs sources", () => {
    process.env.VERCEL_TOKEN = "vercel_test";
    process.env.VERCEL_TEAM = "team_test";
    const parsed = parseConfig(`
sources:
  vercel:
    provider: vercel-logs
    team_id: env:VERCEL_TEAM
    api_token: env:VERCEL_TOKEN
    projects:
      - prj_test

sinks:
  slack:
    type: slack
    webhook_url: https://hooks.slack.test/services/x/y/z

monitors:
  - name: vercel-errors
    filter: [errors]
    sinks: [slack]
`);

    const connection = parsed.input.connections[0]!;
    expect(connection.connection.provider).toBe("vercel-logs");
    expect(connection.connection.externalAccountId).toBe("team_test");
    expect(connection.credentials).toEqual({ apiToken: "vercel_test" });
    expect(connection.selectedSources).toEqual([
      {
        id: "src_vercel_prj_test",
        externalId: "prj_test",
        displayName: "prj_test",
        sourceKind: "vercel_project",
        metadata: null,
      },
    ]);
    const bundle = generateBundle(parsed.input);
    expect(bundle.vectorYaml).toContain("vercel_con_vercel_tail:");
    expect(bundle.vectorYaml).toContain('"id":"prj_test"');
    expect(bundle.runtimeAssets[0]?.driverId).toBe("vercel-logs");
    expect(bundle.runtimeAssets[0]?.path).toBe("logtura-vercel-tail.mjs");
    expect(bundle.dockerfile).toContain("COPY assets/ /opt/logtura/assets/");
  });
});
