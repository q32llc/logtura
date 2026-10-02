import type { Env } from "./env";

/**
 * Minimal Postmark email helper. Skips silently when POSTMARK_API_KEY
 * isn't configured, which is the right behavior in dev or in early
 * production before the user wires email up.
 */
export async function sendEmail(
  env: Env,
  input: {
    to: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
  },
): Promise<boolean> {
  if (!env.POSTMARK_API_KEY || !env.FROM_EMAIL) {
    console.log("email_skipped_no_config");
    return false;
  }
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    redirect: "manual",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-postmark-server-token": env.POSTMARK_API_KEY,
    },
    body: JSON.stringify({
      From: env.FROM_EMAIL,
      To: input.to,
      Subject: input.subject,
      TextBody: input.textBody,
      HtmlBody: input.htmlBody,
      MessageStream: "outbound",
    }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    console.error("postmark_send_failed", res.status);
    return false;
  }
  await res.body?.cancel();
  return true;
}

export interface DeploymentSilenceContext {
  deploymentId: string;
  displayName: string;
  lastSeenAt: number | null;
  appUrl: string;
}

export function deploymentSilenceEmail(
  ctx: DeploymentSilenceContext,
): { subject: string; textBody: string } {
  const lastSeen = ctx.lastSeenAt
    ? new Date(ctx.lastSeenAt).toISOString()
    : "never";
  const subject = `[logtura] Forwarder "${ctx.displayName}" stopped reporting`;
  const textBody = [
    `Your logtura forwarder "${ctx.displayName}" stopped sending heartbeats.`,
    "",
    `Last seen: ${lastSeen}`,
    `Status: now marked as crashed in your dashboard.`,
    "",
    "What to check:",
    "  1. Is the container still running on your deploy target?",
    "  2. Did the underlying provider's API token expire?",
    "  3. Did the host run out of disk / memory?",
    "",
    `Open the deployment in your dashboard:`,
    `${ctx.appUrl}/app/deployments/${ctx.deploymentId}`,
    "",
    "If the forwarder is back up, this email won't repeat — the next",
    "heartbeat will flip the status back to running automatically.",
  ].join("\n");
  return { subject, textBody };
}
