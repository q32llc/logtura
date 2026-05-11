import type { DestinationDriver, SinkBundle } from "./types";
import { DestinationError } from "./types";

/**
 * Slack incoming-webhook OAuth (https://api.slack.com/messaging/webhooks).
 *
 * Flow:
 *   1. UI hits GET /api/destinations/slack/start
 *      → server signs a state cookie + 303s to slack.com/oauth/v2/authorize
 *   2. Slack callback hits GET /api/destinations/slack/callback?code=...
 *      → server exchanges code for incoming_webhook.url + channel + team
 *      → creates a destination row with this driver's config
 *      → 303s back to /app/destinations
 *
 * Requires SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in the env. App must
 * be registered at api.slack.com/apps with the redirect URI
 * <APP_URL>/api/destinations/slack/callback and the
 * `incoming-webhook` scope.
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
  connectFlow: {
    kind: "oauth_redirect",
    startPath: "/api/destinations/slack/start",
    buttonLabel: "Connect Slack",
    buttonDescription:
      "Sign in to your Slack workspace and pick a channel. We get a webhook URL for that channel; you can revoke it from Slack at any time.",
  },
  // formFields is empty because the OAuth flow does the work.
  // The connect-flow handler plants the resulting config into a
  // hidden form for the create-destination step. Listed here so the
  // generic destination form can render `display_name` plus zero
  // driver fields.
  formFields: [],

  parseFormData(form) {
    // The OAuth callback POSTs here with hidden fields populated from
    // the token exchange. Used only by the OAuth path; direct form
    // submission isn't supported (formFields is empty).
    const webhookUrl = String(form.get("webhook_url") ?? "").trim();
    const teamName = String(form.get("team_name") ?? "").trim() || null;
    const channel = String(form.get("channel") ?? "").trim() || null;
    if (!webhookUrl) {
      throw new DestinationError(
        "Slack OAuth did not return a webhook URL",
        400,
      );
    }
    return { config: { webhookUrl, teamName, channel } };
  },

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
