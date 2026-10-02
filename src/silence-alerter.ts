import type { Env } from "./env";
import { deploymentSilenceEmail, sendEmail } from "./email";

const SILENCE_MS = 600_000, COOLDOWN_MS = 3_600_000, LEASE_MS = 60_000;
const CAPTURE_LIMIT = 100, DELIVERY_LIMIT = 10, RETENTION_MS = 7 * 86_400_000;
type Notice = { deployment_id: string; observed_last_seen_at: number; display_name: string; email: string | null; attempts: number };

/** Atomic, bounded capture. No application read/write gap and no full payloads
 * or per-owner lookups. D1 batch rolls both statements back on SQL failure. */
export async function captureSilenceNotifications(db: D1Database, now = Date.now()): Promise<number> {
  const batch = crypto.randomUUID();
  const result = await db.batch([
    db.prepare(`INSERT INTO silence_notifications
      (deployment_id, observed_last_seen_at, display_name, email, capture_batch, created_at, next_attempt_at)
      SELECT d.id, d.last_seen_at, d.display_name, u.email, ?, ?, ?
      FROM deployments d LEFT JOIN users u ON u.id = d.user_id
      WHERE d.status = 'running' AND d.last_seen_at IS NOT NULL AND d.last_seen_at < ?
        AND (d.last_alert_sent_at IS NULL OR d.last_alert_sent_at < ?)
      ORDER BY d.last_seen_at, d.id LIMIT ?
      ON CONFLICT(deployment_id, observed_last_seen_at) DO UPDATE SET capture_batch = excluded.capture_batch`)
      .bind(batch, now, now, now - SILENCE_MS, now - COOLDOWN_MS, CAPTURE_LIMIT),
    db.prepare(`UPDATE deployments SET status = 'crashed', last_alert_sent_at = ?, updated_at = MAX(updated_at, ?)
      WHERE id IN (SELECT deployment_id FROM silence_notifications WHERE capture_batch = ?)`)
      .bind(now, now, batch),
  ]);
  return result[0]!.meta.changes ?? 0;
}

/** Durable at-least-once delivery: an accepted send followed by a lost D1 ack
 * can repeat. Leases prevent normal overlapping ticks from duplicating sends. */
export async function deliverSilenceNotifications(env: Env, clock = Date.now): Promise<void> {
  const now = clock();
  // Delete only a bounded old completed batch; pending failures remain durable.
  await env.DB.prepare(`DELETE FROM silence_notifications WHERE rowid IN
    (SELECT rowid FROM silence_notifications WHERE completed_at IS NOT NULL AND completed_at < ? ORDER BY completed_at LIMIT ?)`)
    .bind(now - RETENTION_MS, CAPTURE_LIMIT).run();
  if (!env.POSTMARK_API_KEY || !env.FROM_EMAIL) return;
  const ready = await env.DB.prepare(`SELECT deployment_id, observed_last_seen_at FROM silence_notifications
    WHERE completed_at IS NULL AND next_attempt_at <= ? AND lease_until <= ?
    ORDER BY next_attempt_at, deployment_id LIMIT ?`).bind(now, now, DELIVERY_LIMIT).all<Notice>();
  for (const key of ready.results ?? []) {
    const ts = clock(), token = crypto.randomUUID();
    const notice = await env.DB.prepare(`UPDATE silence_notifications SET lease_token = ?, lease_until = ?, attempts = attempts + 1
      WHERE deployment_id = ? AND observed_last_seen_at = ? AND completed_at IS NULL AND next_attempt_at <= ? AND lease_until <= ?
      RETURNING deployment_id, observed_last_seen_at, display_name, email, attempts`)
      .bind(token, ts + LEASE_MS, key.deployment_id, key.observed_last_seen_at, ts, ts).first<Notice>();
    if (!notice) continue;
    const current = await env.DB.prepare("SELECT status, last_seen_at FROM deployments WHERE id = ?")
      .bind(notice.deployment_id).first<{ status: string; last_seen_at: number | null }>();
    // Don't send a queued warning for a recovered/stopped/deleted deployment.
    const obsolete = !current || current.status !== "crashed" || current.last_seen_at !== notice.observed_last_seen_at;
    let sent = obsolete || !notice.email;
    if (!sent) {
      const content = deploymentSilenceEmail({ deploymentId: notice.deployment_id, displayName: notice.display_name, lastSeenAt: notice.observed_last_seen_at, appUrl: env.APP_URL });
      try { sent = await sendEmail(env, { to: notice.email!, ...content }); }
      catch { console.error("silence_notification_transport_failed", { deploymentId: notice.deployment_id }); }
    }
    const finished = clock();
    await env.DB.prepare(`UPDATE silence_notifications SET completed_at = ?, next_attempt_at = ?, lease_token = NULL, lease_until = 0
      WHERE deployment_id = ? AND observed_last_seen_at = ? AND lease_token = ?`)
      .bind(sent ? finished : null, finished + Math.min(COOLDOWN_MS, 60_000 * 2 ** Math.min(notice.attempts - 1, 6)), notice.deployment_id, notice.observed_last_seen_at, token).run();
  }
}

export async function runSilenceAlerter(env: Env): Promise<void> {
  const captured = await captureSilenceNotifications(env.DB);
  if (captured) console.log("silence_alerter_found", captured);
  await deliverSilenceNotifications(env);
}
