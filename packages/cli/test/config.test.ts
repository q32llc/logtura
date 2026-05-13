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
});
