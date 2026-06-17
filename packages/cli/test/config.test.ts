import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateBundle } from "@logtura/core";
import { parseConfig } from "../src/config";
import { main } from "../src/main";

describe("parseConfig", () => {
  it("separates provider connections from source drivers", () => {
    process.env.CF_TOKEN = "cf_test";
    process.env.CF_ACCOUNT = "acct_test";
    process.env.SLACK_URL = "https://hooks.slack.test/services/x/y/z";

    const parsed = parseConfig(`
providers:
  cloudflare-prod:
    provider: cloudflare
    account_id: env:CF_ACCOUNT
    credentials:
      api_token: env:CF_TOKEN

sources:
  workers:
    source: cloudflare-worker-tail
    scripts:
      - dirtsignal
      - ipogrid

sinks:
  errors-slack:
    sink: slack
    webhook_url: env:SLACK_URL
    channel: "#alerts"

monitors:
  - name: errors
    sinks: [errors-slack]
`);

    expect(parsed.missingEnv).toEqual([]);
    expect(parsed.input.connections[0]!.connection.provider).toBe(
      "cloudflare-worker-tail",
    );
    expect(parsed.input.connections[0]!.connection.externalAccountId).toBe(
      "acct_test",
    );
    expect(parsed.input.connections[0]!.credentials).toEqual({
      apiToken: "cf_test",
    });
    expect(parsed.input.connections[0]!.selectedSources).toHaveLength(2);

    const bundle = generateBundle(parsed.input);
    expect(bundle.vectorYaml).toContain("logtura-cf-tail");
    expect(bundle.envVars.find((v) => v.name === "CLOUDFLARE_API_TOKEN")?.value)
      .toBe("cf_test");
    expect(bundle.envVars.some((v) => v.name.includes("SLACK"))).toBe(true);
  });

  it("requires explicit provider when multiple compatible providers exist", () => {
    expect(() =>
      parseConfig(`
providers:
  cf-prod:
    provider: cloudflare
    account_id: acct1
    credentials: { api_token: token1 }
  cf-staging:
    provider: cloudflare
    account_id: acct2
    credentials: { api_token: token2 }

sources:
  workers:
    source: cloudflare-worker-tail
    scripts: [api]
`),
    ).toThrow(/multiple cloudflare providers/);
  });

  it("parses Slack max_message_chars", () => {
    const parsed = parseConfig(`
providers:
  cf:
    provider: cloudflare
    account_id: acct_test
    credentials: { api_token: token_test }

sources:
  workers:
    source: cloudflare-worker-tail
    scripts: [dirtsignal]

sinks:
  slack:
    sink: slack
    webhook_url: https://hooks.slack.test/services/x/y/z
    max_message_chars: 4096

monitors:
  - name: errors
    sinks: [slack]
`);

    const config = parsed.input.monitors[0]!.sinks[0]!.destinationConfig as {
      maxMessageChars?: number | null;
    };
    expect(config.maxMessageChars).toBe(4096);
  });

  it("reads env: values from adjacent .env files", () => {
    const oldToken = process.env.CF_TOKEN;
    const oldAccount = process.env.CF_ACCOUNT;
    delete process.env.CF_TOKEN;
    delete process.env.CF_ACCOUNT;
    const dir = mkdtempSync(join(tmpdir(), "logt-env-"));
    writeFileSync(join(dir, ".env"), "CF_TOKEN=cf_from_dotenv\nCF_ACCOUNT=acct_from_dotenv\n");
    try {
      const parsed = parseConfig(
        `
providers:
  cf:
    provider: cloudflare
    account_id: env:CF_ACCOUNT
    credentials:
      api_token: env:CF_TOKEN
sources:
  workers:
    source: cloudflare-worker-tail
    scripts: [api]
    `,
        join(dir, "logt.yaml"),
      );
      expect(parsed.missingEnv).toEqual([]);
      expect(parsed.input.connections[0]!.credentials).toEqual({
        apiToken: "cf_from_dotenv",
      });
    } finally {
      if (oldToken === undefined) delete process.env.CF_TOKEN;
      else process.env.CF_TOKEN = oldToken;
      if (oldAccount === undefined) delete process.env.CF_ACCOUNT;
      else process.env.CF_ACCOUNT = oldAccount;
    }
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
    source: custom-vector
    display_name: Bob
    vector:
      include: ./vector/bob.yaml
      feed: bob_norm

sinks:
  joe:
    sink: custom-vector
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
  });

  it("parses Railway Logs sources through a Railway provider", () => {
    const parsed = parseConfig(`
providers:
  railway:
    provider: railway
    credentials:
      api_token: railway_test
    environment_id: env_test

sources:
  railway-services:
    source: railway-logs
    services:
      - id: svc_test
        name: api

sinks:
  slack:
    sink: slack
    webhook_url: https://hooks.slack.test/services/x/y/z

monitors:
  - name: railway-errors
    filter: [errors]
    sinks: [slack]
`);

    const connection = parsed.input.connections[0]!;
    expect(connection.connection.provider).toBe("railway-logs");
    expect(connection.credentials).toEqual({
      apiToken: "railway_test",
      projectId: null,
      environmentId: "env_test",
    });
  });
});

describe("main", () => {
  it("supports logt init/source/sink/monitor editor workflow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "logt-cli-"));
    const config = join(dir, "logt.yaml");

    expect(await main(["--config", config, "init"])).toBe(0);
    expect(await main(["--config", config, "source", "add", "cloudflare-worker-tail"])).toBe(0);
    expect(await main(["--config", config, "sink", "add", "slack", "errors-slack"])).toBe(0);
    expect(await main(["--config", config, "monitor", "add", "errors", "errors-slack"])).toBe(0);

    const text = await import("node:fs").then((fs) => fs.readFileSync(config, "utf8"));
    expect(text).toContain("source: cloudflare-worker-tail");
    expect(text).toContain("sink: slack");
    expect(text).toContain("name: errors");
  });

  it("treats deploy --write-env as env --write before deploy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "logt-cli-env-"));
    const config = join(dir, "logt.yaml");
    expect(await main(["--config", config, "init"])).toBe(0);
    writeFileSync(
      config,
      `
providers:
  cloudflare:
    provider: cloudflare
    account_id: env:CLOUDFLARE_ACCOUNT_ID
    credentials:
      api_token: env:CLOUDFLARE_API_TOKEN
sources:
  cloudflare-worker:
    source: cloudflare-worker-tail
    scripts: []
sinks: {}
monitors: []
`,
    );
    expect(await main(["--config", config, "source", "add", "cloudflare-worker-tail"])).toBe(0);
    expect(await main(["--config", config, "sink", "add", "slack", "errors-slack"])).toBe(0);
    expect(await main(["--config", config, "monitor", "add", "errors", "errors-slack"])).toBe(0);

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await main(["--config", config, "deploy", "fly", "--write-env"])).toBe(1);
      const envText = await import("node:fs").then((fs) =>
        fs.readFileSync(join(dir, ".env"), "utf8"),
      );
      expect(envText).toContain("CLOUDFLARE_API_TOKEN=");
      expect(envText).toContain("SLACK_ERRORS_SLACK_WEBHOOK_URL=");
    } finally {
      process.chdir(cwd);
    }
  });
});
