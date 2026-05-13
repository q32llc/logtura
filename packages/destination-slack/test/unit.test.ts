import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLACK_MAX_MESSAGE_CHARS,
  slackDriver,
} from "../src/index";

// parseFormData is intentionally outside the destination driver; the
// CLI passes explicit Slack config.

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
    expect(remap).toContain('. = { "text": text }');
    // Fallback when .message is missing/empty — guards against 400
    // ("no_text") from the Slack incoming-webhook endpoint.
    expect(remap).toContain('if msg == "" {');
    expect(remap).toContain(`max_message_chars = ${DEFAULT_SLACK_MAX_MESSAGE_CHARS}`);

    const sink = bundle.sink.yaml;
    expect(sink).toContain("type: http");
    // Slack's incoming-webhook needs a single OBJECT body, not a
    // JSON array of events.
    expect(sink).toContain("method: newline_delimited");
    expect(sink).toContain("max_events: 1");
  });

  it("truncates normal messages when maxMessageChars is configured", () => {
    const bundle = slackDriver.generateSinkBundle({
      config: {
        webhookUrl: "ignored",
        teamName: null,
        channel: null,
        maxMessageChars: 80,
      },
      inputs: ["mon_x_0"],
      sinkKey: "sink_snk_y",
      envVarName: "SLACK_WEBHOOK_URL_dst_z",
    });
    const remap = bundle.preSinkTransforms![0]!.yaml;
    expect(remap).toContain("max_message_chars = 80");
    expect(remap).toContain("if !is_error && length(text) > max_message_chars");
    expect(remap).toContain("[logtura: message truncated]");
  });

  it("preserves error exception blocks before truncating exception text as a last resort", () => {
    const bundle = slackDriver.generateSinkBundle({
      config: {
        webhookUrl: "ignored",
        teamName: null,
        channel: null,
        maxMessageChars: 80,
      },
      inputs: ["mon_x_0"],
      sinkKey: "sink_snk_y",
      envVarName: "SLACK_WEBHOOK_URL_dst_z",
    });
    const remap = bundle.preSinkTransforms![0]!.yaml;
    expect(remap).toContain("error_reason");
    expect(remap).toContain("exceptions = array(.exceptions) ?? []");
    expect(remap).toContain("for_each(exceptions)");
    expect(remap).toContain("length(exception_text) >= max_message_chars");
    expect(remap).toContain("[logtura: exception truncated]");
  });

  it("uses the default maxMessageChars when the field is missing", () => {
    const bundle = slackDriver.generateSinkBundle({
      config: { webhookUrl: "ignored", teamName: null, channel: null },
      inputs: ["mon_x_0"],
      sinkKey: "sink_snk_y",
      envVarName: "SLACK_WEBHOOK_URL_dst_z",
    });
    expect(bundle.preSinkTransforms![0]!.yaml).toContain(
      `max_message_chars = ${DEFAULT_SLACK_MAX_MESSAGE_CHARS}`,
    );
  });

  it("allows 0 to disable Logtura-side truncation", () => {
    const bundle = slackDriver.generateSinkBundle({
      config: {
        webhookUrl: "ignored",
        teamName: null,
        channel: null,
        maxMessageChars: 0,
      },
      inputs: ["mon_x_0"],
      sinkKey: "sink_snk_y",
      envVarName: "SLACK_WEBHOOK_URL_dst_z",
    });
    const remap = bundle.preSinkTransforms![0]!.yaml;
    expect(remap).not.toContain("max_message_chars =");
    expect(remap).toContain('. = { "text": text }');
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
