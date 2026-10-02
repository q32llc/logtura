import { slackConnect } from "./connect/slack";
import type { SlackConfig } from "@logtura/destination-slack";

/** Parse only the webhook fields that we store. Provider response bodies can
 * contain access tokens and must never appear in exceptions or logs. */
export async function exchangeSlackWebhook(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ config: SlackConfig; displayName: string }> {
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret,
      code: input.code, redirect_uri: input.redirectUri }).toString(),
  });
  if (!response.ok) throw new Error("Slack OAuth exchange failed");
  let parsed: unknown;
  try { parsed = await response.json(); } catch { throw new Error("Slack OAuth response is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Slack OAuth response has invalid fields");
  const payload = parsed as { ok?: unknown; incoming_webhook?: { url?: unknown; channel?: unknown } | null; team?: { name?: unknown } | null };
  const webhook = payload.incoming_webhook;
  if (payload.ok !== true || !webhook || typeof webhook.url !== "string" || !webhook.url
    || (webhook.channel !== undefined && webhook.channel !== null && typeof webhook.channel !== "string")
    || (payload.team?.name !== undefined && payload.team?.name !== null && typeof payload.team.name !== "string")) {
    throw new Error("Slack OAuth response has invalid fields");
  }
  const form = new FormData();
  form.set("webhook_url", webhook.url);
  if (typeof webhook.channel === "string") form.set("channel", webhook.channel);
  if (typeof payload.team?.name === "string") form.set("team_name", payload.team.name);
  const { config } = slackConnect.parseFormData(form);
  const { teamName, channel } = config;
  const displayName = teamName ? channel ? `${teamName} #${channel.replace(/^#/, "")}` : teamName : "Slack";
  return { config, displayName };
}

export function readSlackOAuthState(json: string, expected: string): { state: string; userId: string } | null {
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const state = value as Record<string, unknown>;
    if (state.state !== expected || typeof state.userId !== "string" || !state.userId) return null;
    return { state: expected, userId: state.userId };
  } catch { return null; }
}
