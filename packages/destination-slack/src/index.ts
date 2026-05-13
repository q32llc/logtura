import {
  type DestinationDriver,
  type SinkBundle,
} from "@logtura/core";

export const DEFAULT_SLACK_MAX_MESSAGE_CHARS = 12000;

/**
 * Slack incoming-webhook destination.
 *
 * OAuth flow (slack.com/oauth/v2/authorize redirect) can produce the
 * `webhookUrl`, `teamName`, and `channel` fields in SlackConfig; this
 * driver just renders the http sink. The CLI accepts explicit config.
 */
export interface SlackConfig {
  webhookUrl: string;
  teamName: string | null;
  channel: string | null;
  /** Default 12000. null or 0 disables Logtura-side truncation. */
  maxMessageChars?: number | null;
}

export const slackDriver: DestinationDriver<SlackConfig> = {
  id: "slack",
  displayName: "Slack",
  description:
    "Post matched log lines to a Slack channel. OAuth into your workspace and pick a channel; we never see your messages, just the webhook URL Slack hands out.",
  flows: ["logs"],

  generateSinkBundle({ config, inputs, sinkKey, envVarName }): SinkBundle {
    // Slack incoming-webhooks expect {text: "..."} JSON. We insert a
    // remap before the http sink to coerce arbitrary log events into
    // that shape — preferring `.message`, falling back to a JSON
    // dump of the whole event so users at least see *something*.
    const remapKey = `${sinkKey}_format`;
    const maxMessageChars = normalizeMaxMessageChars(config.maxMessageChars);
    const remapYaml = [
      "    type: remap",
      `    inputs: [${inputs.map((i) => `"${i}"`).join(", ")}]`,
      "    source: |-",
      ...slackFormatVrl(maxMessageChars),
    ].join("\n");

    const sinkYaml = [
      "    type: http",
      `    inputs: ["${remapKey}"]`,
      `    uri: "\${${envVarName}}"`,
      "    method: post",
      "    encoding:",
      "      codec: json",
      // Vector's default for codec: json wraps the batch in a JSON
      // ARRAY (`[{"text":"…"}]`). Slack's incoming-webhook endpoint
      // expects a top-level OBJECT (`{"text":"…"}`) and replies with
      // a 400 (`no_text` / `invalid_payload`) on an array. With
      // max_events: 1 + newline_delimited framing the body becomes
      // just `{"text":"…"}\n` — one event per request, one JSON
      // object per body, which is what Slack wants.
      "    framing:",
      "      method: newline_delimited",
      "    request:",
      "      headers:",
      "        content-type: application/json",
      "    batch:",
      "      max_events: 1",
      "      timeout_secs: 5",
      "    healthcheck:",
      "      enabled: false",
    ].join("\n");

    return {
      preSinkTransforms: [{ key: remapKey, yaml: remapYaml }],
      sink: { key: sinkKey, yaml: sinkYaml },
    };
  },

  runtimeEnvVars({ envVarName, displayName }) {
    return [
      {
        name: envVarName,
        description: `Slack incoming-webhook URL for "${displayName}"`,
        source: "destination",
      },
    ];
  },

  envVarValue(config) {
    return config.webhookUrl;
  },
};

function normalizeMaxMessageChars(value: number | null | undefined): number | null {
  if (value === null || value === 0) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_SLACK_MAX_MESSAGE_CHARS;
}

function slackFormatVrl(maxMessageChars: number | null): string[] {
  const lines = [
    // Slack incoming-webhook rejects {"text": ""} with HTTP 400.
    // Defensive fallback: if .message is empty or missing, render
    // the event itself as JSON so the user at least sees what came through.
    '      msg = string(.message) ?? ""',
    '      if msg == "" { msg = "(empty .message) " + encode_json(.) }',
    '      is_error = (bool(.error) ?? false) || (string(.level) ?? "") == "error"',
    "      exception_parts = []",
    '      error_reason = string(.error_reason) ?? ""',
    '      if error_reason != "" { exception_parts = push(exception_parts, "error_reason: " + error_reason) }',
    "      exceptions = array(.exceptions) ?? []",
    "      for_each(exceptions) -> |_, ex| {",
    '        name = string(ex.name) ?? "Error"',
    '        body = string(ex.message) ?? ""',
    '        stack = string(ex.stack) ?? ""',
    '        rendered = if stack != "" { name + ": " + body + "\\n" + stack } else { name + ": " + body }',
    "        exception_parts = push(exception_parts, rendered)",
    "      }",
    '      exception_text = join!(exception_parts, "\\n")',
    '      text = if is_error && exception_text != "" { msg + "\\n\\n" + exception_text } else { msg }',
  ];
  if (maxMessageChars === null) {
    return [...lines, '      . = { "text": text }'];
  }
  return [
    ...lines,
    `      max_message_chars = ${maxMessageChars}`,
    '      message_marker = "\\n[logtura: message truncated]"',
    '      exception_marker = "\\n[logtura: exception truncated]"',
    "      if !is_error && length(text) > max_message_chars {",
    "        keep = max_message_chars - length(message_marker)",
    "        text = if keep > 0 { slice!(text, 0, keep) + message_marker } else { slice!(text, 0, max_message_chars) }",
    "      }",
    "      if is_error && length(text) > max_message_chars {",
    "        if exception_text != \"\" && length(exception_text) >= max_message_chars {",
    "          keep = max_message_chars - length(exception_marker)",
    "          exception_text = if keep > 0 { slice!(exception_text, 0, keep) + exception_marker } else { slice!(exception_text, 0, max_message_chars) }",
    "          msg = \"\"",
    "        } else {",
    "          available = max_message_chars - length(exception_text) - 2",
    "          keep = available - length(message_marker)",
    "          if keep > 0 && length(msg) > available { msg = slice!(msg, 0, keep) + message_marker }",
    "        }",
    "        text = if exception_text != \"\" && msg != \"\" { msg + \"\\n\\n\" + exception_text } else if exception_text != \"\" { exception_text } else { msg }",
    "      }",
    '      . = { "text": text }',
  ];
}
