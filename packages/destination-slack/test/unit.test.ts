import { describe, expect, it } from "vitest";
import { slackDriver } from "../src/index";

describe("parseFormData", () => {
  it("accepts webhook_url + team + channel from the OAuth callback", () => {
    const f = new FormData();
    f.set("webhook_url", "https://hooks.slack.com/services/T00/B00/XXX");
    f.set("team_name", "q32");
    f.set("channel", "alerts");
    const out = slackDriver.parseFormData(f);
    expect(out.config).toEqual({
      webhookUrl: "https://hooks.slack.com/services/T00/B00/XXX",
      teamName: "q32",
      channel: "alerts",
    });
  });

  it("rejects when webhook_url is missing", () => {
    const f = new FormData();
    f.set("webhook_url", "");
    expect(() => slackDriver.parseFormData(f)).toThrow(
      /OAuth did not return a webhook URL/,
    );
  });

  it("treats blank optional fields as null", () => {
    const f = new FormData();
    f.set("webhook_url", "https://hooks.slack.com/x");
    expect(slackDriver.parseFormData(f).config).toEqual({
      webhookUrl: "https://hooks.slack.com/x",
      teamName: null,
      channel: null,
    });
  });
});

describe("generateSinkBundle", () => {
  it("emits a {text} remap + http sink with newline_delimited framing", () => {
    const bundle = slackDriver.generateSinkBundle({
      config: { webhookUrl: "ignored", teamName: null, channel: null },
      inputs: ["mon_x_0"],
      sinkKey: "sink_snk_y",
      envVarName: "SLACK_WEBHOOK_URL_dst_z",
    });
    expect(bundle.preSinkTransforms?.[0]?.key).toBe("sink_snk_y_format");
    const remap = bundle.preSinkTransforms![0]!.yaml;
    expect(remap).toContain('. = { "text": msg }');
    // Fallback when .message is missing/empty — guards against 400
    // ("no_text") from the Slack incoming-webhook endpoint.
    expect(remap).toContain('if msg == "" {');

    const sink = bundle.sink.yaml;
    expect(sink).toContain("type: http");
    // Slack's incoming-webhook needs a single OBJECT body, not a
    // JSON array of events.
    expect(sink).toContain("method: newline_delimited");
    expect(sink).toContain("max_events: 1");
  });
});

describe("envVarValue", () => {
  it("returns the webhook URL", () => {
    expect(
      slackDriver.envVarValue(
        { webhookUrl: "https://hooks.slack.com/x", teamName: null, channel: null },
        "anything",
      ),
    ).toBe("https://hooks.slack.com/x");
  });
});
