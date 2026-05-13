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
});
