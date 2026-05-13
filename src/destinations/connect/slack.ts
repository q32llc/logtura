import { DestinationError } from "@logtura/core";
import {
  DEFAULT_SLACK_MAX_MESSAGE_CHARS,
  type SlackConfig,
} from "@logtura/destination-slack";
import type { DestinationConnectAdapter } from "./types";

/**
 * Slack destination connect-UX. OAuth flow runs entirely host-side
 * (the `/api/destinations/slack/start` route plants the OAuth state
 * cookie + redirects to slack.com/oauth/v2/authorize; the callback
 * POSTs back here with `webhook_url`, `team_name`, `channel` filled
 * in as hidden form fields).
 */
export const slackConnect: DestinationConnectAdapter<SlackConfig> = {
  driverId: "slack",
  connectFlow: {
    kind: "oauth_redirect",
    startPath: "/api/destinations/slack/start",
    buttonLabel: "Connect Slack",
    buttonDescription:
      "Sign in to your Slack workspace and pick a channel. We get a webhook URL for that channel; you can revoke it from Slack at any time.",
  },
  formFields: [],
  parseFormData(form) {
    const webhookUrl = String(form.get("webhook_url") ?? "").trim();
    const teamName = String(form.get("team_name") ?? "").trim() || null;
    const channel = String(form.get("channel") ?? "").trim() || null;
    if (!webhookUrl) {
      throw new DestinationError(
        "Slack OAuth did not return a webhook URL",
        400,
      );
    }
    return {
      config: {
        webhookUrl,
        teamName,
        channel,
        maxMessageChars: DEFAULT_SLACK_MAX_MESSAGE_CHARS,
      },
    };
  },
};
