import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { createConnection, createDeployment } from "../../src/db";
import { captureSilenceNotifications, deliverSilenceNotifications, runSilenceAlerter } from "../../src/silence-alerter";
import { deploymentSilenceEmail, sendEmail } from "../../src/email";
import type { Env } from "../../src/env";
import { mockFetch, seedUser } from "./_setup";
const now = Date.now(), stale = now - 600_001;
beforeEach(async () => {
  await env.DB.exec("DROP TRIGGER IF EXISTS fail_silence;");
  await env.DB.prepare("DELETE FROM users").run();
});
const configured = () => ({ ...env, POSTMARK_API_KEY: "fixture", FROM_EMAIL: "sender@example.com" }) as Env;
async function fixture(status = "running", seen: number | null = stale, alert: number | null = null) {
  const { userId } = await seedUser();
  const connection = await createConnection(env.DB, env, { userId, provider: "cloudflare-worker-tail", displayName: "Ingest", credentials: { apiToken: "fixture" }, externalAccountId: "account" });
  const d = await createDeployment(env.DB, { userId, connectionId: connection.id, displayName: "Silent", targetKind: "other", heartbeatTarget: "logtura" });
  await env.DB.prepare("UPDATE deployments SET status=?, last_seen_at=?, last_alert_sent_at=? WHERE id=?").bind(status, seen, alert, d.id).run();
  const read = () => env.DB.prepare("SELECT status,last_seen_at,last_alert_sent_at,updated_at FROM deployments WHERE id=?").bind(d.id).first();
  const notices = () => env.DB.prepare("SELECT * FROM silence_notifications WHERE deployment_id=?").bind(d.id).all<Record<string, unknown>>();
  return { id: d.id, userId, read, notices };
}
it("captures narrow indexed stale rows and preserves desired configuration versions", async () => {
  const f = await fixture();
  const before = await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id=?").bind(f.userId).first();
  expect(await captureSilenceNotifications(env.DB, now)).toBe(1);
  expect(await f.read()).toMatchObject({ status: "crashed", last_seen_at: stale, last_alert_sent_at: now });
  expect((await f.notices()).results).toHaveLength(1);
  expect(await env.DB.prepare("SELECT version FROM configuration_versions WHERE user_id=?").bind(f.userId).first()).toEqual(before);
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM deployments WHERE status='running' AND last_seen_at IS NOT NULL AND last_seen_at<? AND (last_alert_sent_at IS NULL OR last_alert_sent_at<?) ORDER BY last_seen_at,id LIMIT 100").bind(now - 600_000, now - 3_600_000).all<{ detail: string }>();
  expect(plan.results.some(r => r.detail.includes("deployments_silence_candidates"))).toBe(true);
});
it.each([["running", null, null], ["running", now - 600_000, null], ["running", stale, now - 3_600_000], ["pending", stale, null], ["stopped", stale, null], ["crashed", stale, null]])("does not alert ineligible %s/%s/%s", async (status, seen, alert) => {
  await fixture(status as string, seen as number | null, alert as number | null); expect(await captureSilenceNotifications(env.DB, now)).toBe(0);
});
it("overlapping captures create one episode and overlapping deliveries send once", async () => {
  const f = await fixture(); expect((await Promise.all([captureSilenceNotifications(env.DB, now), captureSilenceNotifications(env.DB, now)])).sort()).toEqual([0, 1]);
  let sends = 0; mockFetch("https://api.postmarkapp.com/email", async req => { sends++; expect(req.headers.get("x-postmark-server-token")).toBe("fixture"); expect(await req.json()).toMatchObject({ To: "test@example.com", Subject: '[logtura] Forwarder "Silent" stopped reporting' }); return new Response("{}", { status: 200 }); });
  await Promise.all([deliverSilenceNotifications(configured(), () => now), deliverSilenceNotifications(configured(), () => now)]);
  expect(sends).toBe(1); expect((await f.notices()).results[0]).toMatchObject({ completed_at: now, attempts: 1, lease_token: null });
});
it("retries a rejected email later without another crash transition", async () => {
  const f = await fixture(); await captureSilenceNotifications(env.DB, now); let sends = 0;
  mockFetch("https://api.postmarkapp.com/email", () => { sends++; return new Response("private provider detail", { status: sends === 1 ? 503 : 200 }); });
  const log = vi.spyOn(console, "error"); await deliverSilenceNotifications(configured(), () => now);
  expect(log).toHaveBeenCalledWith("postmark_send_failed", 503); expect(JSON.stringify(log.mock.calls)).not.toContain("private provider detail");
  await deliverSilenceNotifications(configured(), () => now + 59_999); expect(sends).toBe(1);
  await deliverSilenceNotifications(configured(), () => now + 60_000); expect(sends).toBe(2);
  expect((await f.notices()).results[0]).toMatchObject({ completed_at: now + 60_000, attempts: 2 }); log.mockRestore();
});
it("keeps transport failures durable and does not expose exception contents", async () => {
  const f = await fixture(); await captureSilenceNotifications(env.DB, now);
  mockFetch("https://api.postmarkapp.com/email", () => { throw new Error("private token"); }); const log = vi.spyOn(console, "error");
  await deliverSilenceNotifications(configured(), () => now); expect((await f.notices()).results[0]).toMatchObject({ completed_at: null, lease_until: 0 });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private token"); log.mockRestore();
});
it.each(["running", "stopped"])("cancels a queued notice after the deployment becomes %s", async status => {
  const f = await fixture(); await captureSilenceNotifications(env.DB, now); await env.DB.prepare("UPDATE deployments SET status=?,last_seen_at=? WHERE id=?").bind(status, now, f.id).run();
  await deliverSilenceNotifications(configured(), () => now); expect((await f.notices()).results[0]).toMatchObject({ completed_at: now }); expect(await f.read()).toMatchObject({ status, last_seen_at: now });
});
it("does not overwrite a heartbeat arriving during email transport", async () => {
  const f = await fixture(); await captureSilenceNotifications(env.DB, now);
  mockFetch("https://api.postmarkapp.com/email", async () => { await env.DB.prepare("UPDATE deployments SET status='running',last_seen_at=? WHERE id=?").bind(now, f.id).run(); return new Response(null, { status: 200 }); });
  await deliverSilenceNotifications(configured(), () => now); expect(await f.read()).toMatchObject({ status: "running", last_seen_at: now });
});
it("recovers an abandoned lease only after expiration", async () => {
  const f = await fixture(); await captureSilenceNotifications(env.DB, now);
  await env.DB.prepare("UPDATE silence_notifications SET lease_token='dead',lease_until=? WHERE deployment_id=?").bind(now + 60_000, f.id).run();
  let sends = 0; mockFetch("https://api.postmarkapp.com/email", () => { sends++; return new Response(null, { status: 200 }); });
  await deliverSilenceNotifications(configured(), () => now + 59_999); expect(sends).toBe(0);
  await deliverSilenceNotifications(configured(), () => now + 60_000); expect(sends).toBe(1);
});
it("defers email without configuration and completes notices for owners without email", async () => {
  const f = await fixture(); await env.DB.prepare("UPDATE users SET email=NULL WHERE id=?").bind(f.userId).run(); await captureSilenceNotifications(env.DB, now);
  await deliverSilenceNotifications({ ...configured(), POSTMARK_API_KEY: undefined }, () => now); expect((await f.notices()).results[0]).toMatchObject({ completed_at: null, attempts: 0 });
  await deliverSilenceNotifications({ ...configured(), FROM_EMAIL: undefined }, () => now); expect((await f.notices()).results[0]).toMatchObject({ attempts: 0 });
  await deliverSilenceNotifications(configured(), () => now); expect((await f.notices()).results[0]).toMatchObject({ completed_at: now });
});
it("deletion cascades private notification data", async () => {
  const f = await fixture(); await captureSilenceNotifications(env.DB, now); await env.DB.prepare("DELETE FROM deployments WHERE id=?").bind(f.id).run(); expect((await f.notices()).results).toEqual([]);
});
it("runs the scheduled pipeline with no candidates and with one candidate", async () => {
  await runSilenceAlerter(configured()); const f = await fixture(); mockFetch("https://api.postmarkapp.com/email", () => new Response(null, { status: 200 })); await runSilenceAlerter(configured()); expect((await f.notices()).results[0]!.completed_at).not.toBeNull();
});
it("email helper skips missing credentials and formats the never-seen context", async () => {
  const input = { to: "test@example.com", subject: "subject", textBody: "body" };
  expect(await sendEmail({ ...configured(), POSTMARK_API_KEY: undefined }, input)).toBe(false);
  expect(await sendEmail({ ...configured(), FROM_EMAIL: undefined }, input)).toBe(false);
  expect(deploymentSilenceEmail({ deploymentId: "id", displayName: "name", lastSeenAt: null, appUrl: "https://example.com" }).textBody).toContain("Last seen: never");
});
it("rolls back notification capture if the crashed transition fails", async () => {
  const f = await fixture(); await env.DB.exec("CREATE TRIGGER fail_silence BEFORE UPDATE OF status ON deployments WHEN NEW.status='crashed' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  await expect(captureSilenceNotifications(env.DB, now)).rejects.toThrow("fixture failure"); expect((await f.notices()).results).toEqual([]); expect(await f.read()).toMatchObject({ status: "running", last_alert_sent_at: null });
});
it("caps capture at 100 oldest rows and delivery at ten per tick", async () => {
  const f = await fixture(); const d = await env.DB.prepare("SELECT connection_id FROM deployments WHERE id=?").bind(f.id).first<{ connection_id: string }>();
  await env.DB.batch(Array.from({ length: 104 }, (_, i) => env.DB.prepare("INSERT INTO deployments(id,user_id,connection_id,display_name,target_kind,managed,status,last_seen_at,created_at,updated_at) VALUES(?,?,?,'Bulk','other',0,'running',?,?,?)").bind(`bulk_${i}`, f.userId, d!.connection_id, stale - i - 1, now, now)));
  expect(await captureSilenceNotifications(env.DB, now)).toBe(100); expect(await f.read()).toMatchObject({ status: "running" });
  expect(await captureSilenceNotifications(env.DB, now)).toBe(5);
  let sends = 0; mockFetch("https://api.postmarkapp.com/email", () => { sends++; return new Response(null, { status: 200 }); });
  await deliverSilenceNotifications(configured(), () => now); expect(sends).toBe(10);
  expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM silence_notifications WHERE completed_at IS NULL").first<{ count: number }>())!.count).toBe(95);
});
it("prunes only completed notifications older than seven days", async () => {
  const f = await fixture(); await captureSilenceNotifications(env.DB, now); await env.DB.prepare("UPDATE silence_notifications SET completed_at=? WHERE deployment_id=?").bind(now - 7 * 86_400_000 - 1, f.id).run();
  await deliverSilenceNotifications({ ...configured(), POSTMARK_API_KEY: undefined }, () => now); expect((await f.notices()).results).toEqual([]);
});
it("an expired sender cannot acknowledge a replacement sender's lease", async () => {
  const f = await fixture(); await captureSilenceNotifications(env.DB, now);
  mockFetch("https://api.postmarkapp.com/email", async () => { await env.DB.prepare("UPDATE silence_notifications SET lease_token='replacement',lease_until=? WHERE deployment_id=?").bind(now + 120_000, f.id).run(); return new Response(null, { status: 200 }); });
  await deliverSilenceNotifications(configured(), () => now); expect((await f.notices()).results[0]).toMatchObject({ lease_token: "replacement", completed_at: null });
});
it("sends a bounded Postmark request directly", async () => {
  mockFetch("https://api.postmarkapp.com/email", req => { expect(req.redirect).toBe("manual"); expect(req.signal.aborted).toBe(false); return new Response(null, { status: 200 }); });
  expect(await sendEmail(configured(), { to: "test@example.com", subject: "subject", textBody: "body" })).toBe(true);
});
it("does not follow an email redirect with credentials", async () => {
  let calls = 0; mockFetch("https://api.postmarkapp.com/email", () => { calls++; return new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid" } }); });
  expect(await sendEmail(configured(), { to: "test@example.com", subject: "subject", textBody: "body" })).toBe(false); expect(calls).toBe(1);
});
it("re-crashes a manually resumed identical heartbeat without duplicating its completed notice", async () => {
  const f = await fixture(); await captureSilenceNotifications(env.DB, now);
  mockFetch("https://api.postmarkapp.com/email", () => new Response(null, { status: 200 })); await deliverSilenceNotifications(configured(), () => now);
  await env.DB.prepare("UPDATE deployments SET status='running' WHERE id=?").bind(f.id).run();
  expect(await captureSilenceNotifications(env.DB, now + 3_600_001)).toBe(1); expect(await f.read()).toMatchObject({ status: "crashed" }); expect((await f.notices()).results).toHaveLength(1); expect((await f.notices()).results[0]).toMatchObject({ completed_at: now, attempts: 1 });
});
