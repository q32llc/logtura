import {
  type DestinationDriver,
  type SinkBundle,
} from "@logtura/core";

/**
 * Slack incoming-webhook destination.
 *
 * Host-side OAuth flow (slack.com/oauth/v2/authorize redirect)
 * plants the `webhookUrl`, `teamName`, `channel` into a SlackConfig;
 * this driver just renders the http sink. OAuth UX + form parsing
 * live in the SaaS-side connect adapter
 * (src/destinations/connect/slack.ts).
 */
export interface SlackConfig {
  webhookUrl: string;
  teamName: string | null;
  channel: string | null;
}

export const slackDriver: DestinationDriver<SlackConfig> = {
  id: "slack",
  displayName: "Slack",
  description:
    "Post matched log lines to a Slack channel. OAuth into your workspace and pick a channel; we never see your messages, just the webhook URL Slack hands out.",
  flows: ["logs"],

  generateSinkBundle({ inputs, sinkKey, envVarName }): SinkBundle {
    // Slack incoming-webhooks expect {text: "..."} JSON. We insert a
    // remap before the http sink to coerce arbitrary log events into
    // that shape — preferring `.message`, falling back to a JSON
    // dump of the whole event so users at least see *something*.
    const remapKey = `${sinkKey}_format`;
    const remapYaml = [
      "    type: remap",
      `    inputs: [${inputs.map((i) => `"${i}"`).join(", ")}]`,
      "    source: |-",
      // Slack incoming-webhook rejects {"text": ""} with HTTP 400.
      // Defensive fallback: if .message is empty or missing, render
      // the event itself as JSON so the user at least sees what
      // came through. Upstream normalizers should also produce a
      // non-empty .message, but this is the last line of defense.
      '      msg = string(.message) ?? ""',
      '      if msg == "" { msg = "(empty .message) " + encode_json(.) }',
      '      . = { "text": msg }',
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
