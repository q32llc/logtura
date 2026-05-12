import { describe, expect, it } from "vitest";
import { getDestinationConnect } from "../../src/destinations/index";
import { getProviderConnect } from "../../src/providers/index";

const slackConnect = getDestinationConnect("slack")!;
const webhookConnect = getDestinationConnect("webhook")!;
const datadogMetricsConnect = getDestinationConnect("datadog_metrics")!;
const prometheusRemoteWriteConnect = getDestinationConnect(
  "prometheus_remote_write",
)!;

/**
 * Tests for the SaaS-side connect-UX adapters that wrap each OSS
 * driver. parseFormData lived in the driver packages before the
 * @logtura/* OSS split; now it's host-side, and these tests pin
 * the validation behavior (trim, missing-field rejection,
 * scheme requirements) at its new home.
 */

describe("provider connect — cloudflare-worker-tail", () => {
  const adapter = getProviderConnect("cloudflare-worker-tail")!;

  it("trims api_token + auto-detect account when blank", () => {
    const f = new FormData();
    f.set("api_token", "  cfat_abc  ");
    f.set("account_id", "");
    const out = adapter.parseFormData(f);
    expect(out.credentials).toEqual({ apiToken: "cfat_abc" });
    expect(out.explicitAccountId).toBeNull();
  });

  it("rejects missing api_token", () => {
    const f = new FormData();
    f.set("api_token", "");
    expect(() => adapter.parseFormData(f)).toThrow(/Missing api_token/);
  });

  it("returns explicit accountId when provided", () => {
    const f = new FormData();
    f.set("api_token", "cfat_x");
    f.set("account_id", "f0c6ed442ab8c6bf9d102678d9421dd8");
    const out = adapter.parseFormData(f);
    expect(out.explicitAccountId).toBe("f0c6ed442ab8c6bf9d102678d9421dd8");
  });

  it("connectFlow URL pre-checks Workers Scripts:Read + Workers Tail:Read", () => {
    // Cloudflare's token page supports permissionGroupKeys via URL
    // param; the adapter encodes the right scopes so users land on
    // the dashboard one click from "Create Token". Regression-pin
    // this since the URL-template assembly is the only thing
    // making this driver feel one-click in the UI.
    const url = adapter.connectFlow!.kind === "external_token"
      ? adapter.connectFlow.url
      : "";
    expect(url).toContain("workers_scripts");
    expect(url).toContain("workers_tail");
  });
});

describe("provider connect — cloudflare-ai-gateway", () => {
  const adapter = getProviderConnect("cloudflare-ai-gateway")!;

  it("parses pat + optional account id same as worker-tail", () => {
    const f = new FormData();
    f.set("api_token", "cfat_aigw");
    const out = adapter.parseFormData(f);
    expect(out.credentials).toEqual({ apiToken: "cfat_aigw" });
    expect(out.explicitAccountId).toBeNull();
  });

  it("connectFlow URL pre-checks AI Gateway:Read", () => {
    // Regression-pin: earlier adapter shipped a bare token URL on
    // the (incorrect) assumption that no permissionGroupKeys slug
    // existed. CF accepts `ai_gateway` and renders the scope pre-
    // checked on the custom-token page.
    const url = adapter.connectFlow!.kind === "external_token"
      ? adapter.connectFlow.url
      : "";
    expect(url).toContain("ai_gateway");
  });
});

describe("provider connect — fly-log-tail", () => {
  const adapter = getProviderConnect("fly-log-tail")!;

  it("trims FlyV1 token and accepts optional org_slug", () => {
    const f = new FormData();
    f.set("api_token", "  FlyV1 fm2_abc  ");
    f.set("org_slug", "my-org");
    const out = adapter.parseFormData(f);
    expect(out.credentials).toEqual({ apiToken: "FlyV1 fm2_abc" });
    expect(out.explicitAccountId).toBe("my-org");
  });

  it("rejects missing api_token", () => {
    const f = new FormData();
    f.set("api_token", "");
    expect(() => adapter.parseFormData(f)).toThrow(/Missing api_token/);
  });
});

describe("provider connect — supabase-edge-logs", () => {
  const adapter = getProviderConnect("supabase-edge-logs")!;

  it("trims pat and defers project pick to the picker UI", () => {
    const f = new FormData();
    f.set("pat", "  sbp_abc  ");
    // project_ref isn't a form field anymore — the picker handles
    // it post-create. Setting it here should have no effect.
    f.set("project_ref", " edzvfyvdtvwrnaoyupqq ");
    const out = adapter.parseFormData(f);
    expect(out.credentials).toEqual({ pat: "sbp_abc" });
    expect(out.explicitAccountId).toBeNull();
  });

  it("rejects missing pat", () => {
    const f = new FormData();
    f.set("pat", "");
    expect(() => adapter.parseFormData(f)).toThrow(/Missing pat/);
  });
});

describe("destination connect — slack", () => {
  it("accepts OAuth callback fields", () => {
    const f = new FormData();
    f.set("webhook_url", "https://hooks.slack.com/services/T00/B00/XXX");
    f.set("team_name", "q32");
    f.set("channel", "alerts");
    const out = slackConnect.parseFormData(f);
    expect(out.config).toEqual({
      webhookUrl: "https://hooks.slack.com/services/T00/B00/XXX",
      teamName: "q32",
      channel: "alerts",
    });
  });

  it("rejects when OAuth returns no webhook_url", () => {
    const f = new FormData();
    f.set("webhook_url", "");
    expect(() => slackConnect.parseFormData(f)).toThrow(
      /OAuth did not return a webhook URL/,
    );
  });

  it("treats blank optional fields as null", () => {
    const f = new FormData();
    f.set("webhook_url", "https://hooks.slack.com/x");
    expect(slackConnect.parseFormData(f).config).toEqual({
      webhookUrl: "https://hooks.slack.com/x",
      teamName: null,
      channel: null,
    });
  });
});

describe("destination connect — webhook", () => {
  it("accepts https URLs", () => {
    const f = new FormData();
    f.set("url", "https://hooks.example.com/x");
    expect(webhookConnect.parseFormData(f).config).toEqual({
      url: "https://hooks.example.com/x",
    });
  });

  it("rejects non-https URLs", () => {
    const f = new FormData();
    f.set("url", "http://example.com/x");
    expect(() => webhookConnect.parseFormData(f)).toThrow(/must start with https/);
  });

  it("rejects empty URL", () => {
    const f = new FormData();
    f.set("url", "");
    expect(() => webhookConnect.parseFormData(f)).toThrow(/Missing webhook URL/);
  });
});

describe("destination connect — datadog-metrics", () => {
  it("defaults site to datadoghq.com", () => {
    const f = new FormData();
    f.set("apiKey", "ddog_xxxxx");
    expect(datadogMetricsConnect.parseFormData(f).config).toEqual({
      apiKey: "ddog_xxxxx",
      site: "datadoghq.com",
    });
  });

  it("respects explicit site", () => {
    const f = new FormData();
    f.set("apiKey", "ddog_xxxxx");
    f.set("site", "datadoghq.eu");
    expect(datadogMetricsConnect.parseFormData(f).config.site).toBe(
      "datadoghq.eu",
    );
  });

  it("rejects missing apiKey", () => {
    const f = new FormData();
    f.set("apiKey", "");
    expect(() => datadogMetricsConnect.parseFormData(f)).toThrow(
      /Missing Datadog API key/,
    );
  });
});

describe("destination connect — prometheus-remote-write", () => {
  it("accepts endpoint without a bearer", () => {
    const f = new FormData();
    f.set("endpoint", "https://prom.example.com/api/v1/write");
    expect(prometheusRemoteWriteConnect.parseFormData(f).config).toEqual({
      endpoint: "https://prom.example.com/api/v1/write",
      bearerToken: null,
    });
  });

  it("accepts endpoint + bearer", () => {
    const f = new FormData();
    f.set("endpoint", "https://prom.example.com/api/v1/write");
    f.set("bearerToken", "tok_abc");
    expect(
      prometheusRemoteWriteConnect.parseFormData(f).config.bearerToken,
    ).toBe("tok_abc");
  });

  it("rejects non-https endpoints", () => {
    const f = new FormData();
    f.set("endpoint", "http://prom/api/v1/write");
    expect(() => prometheusRemoteWriteConnect.parseFormData(f)).toThrow(
      /must start with https/,
    );
  });
});
