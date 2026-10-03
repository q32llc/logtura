import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { createDeploymentIngest } from "../../src/deployment-ingest";
import { parseMetricsBody, type MetricsSnapshot } from "../../src/metrics-snapshot";
import { createConnection, createDeployment } from "../../src/db";
import { seedUser } from "./_setup";
import worker from "../../src/index";

async function fixture(status = "running") {
  const { userId } = await seedUser();
  const connection = await createConnection(env.DB, env, { userId, provider: "cloudflare-worker-tail", displayName: "Ingest", credentials: { apiToken: "fixture" }, externalAccountId: "account" });
  const deployment = await createDeployment(env.DB, { userId, connectionId: connection.id, displayName: "Forwarder", targetKind: "other", heartbeatTarget: "logtura" });
  await env.DB.prepare("UPDATE deployments SET status=? WHERE id=?").bind(status, deployment.id).run();
  const now = Date.now(), id = deployment.id, token = deployment.heartbeat_token!;
  const read = async () => env.DB.prepare("SELECT status,last_seen_at,metrics_snapshot_json,updated_at FROM deployments WHERE id=?").bind(id).first<{ status: string; last_seen_at: number | null; metrics_snapshot_json: string | null; updated_at: number }>();
  const snapshot = async () => JSON.parse((await read())!.metrics_snapshot_json!) as MetricsSnapshot;
  return { id, token, now, read, snapshot };
}
function metrics(value: number, time: number, field = "sent", component = "sink") {
  return parseMetricsBody(JSON.stringify({ name: `component_${field}_events_total`, timestamp: time, counter: { value }, tags: { component_id: component, component_kind: "sink", component_type: "http" } }));
}
function errors(value: number, time: number) { return parseMetricsBody(JSON.stringify({ name: "component_errors_total", timestamp: time, counter: { value }, tags: { component_id: "sink", error_type: "http" } })); }
function countDatabase() {
  const calls: string[] = [];
  const db = { prepare(query: string) { calls.push(query); return env.DB.prepare(query); } } as D1Database;
  return { db, calls };
}
it("keeps ordinary warm-isolate traffic in memory and persists only a due checkpoint", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(), counted = countDatabase();
  expect(await coordinator.ingest(counted.db, f.id, f.token, metrics(1, f.now), f.now)).toBe("ok");
  const count = counted.calls.length;
  expect(await coordinator.ingest(counted.db, f.id, f.token, metrics(2, f.now + 1000), f.now + 1000)).toBe("ok");
  expect(await coordinator.ingest(counted.db, f.id, f.token, [], f.now + 2000)).toBe("ok"); expect(counted.calls).toHaveLength(count);
  expect((await f.snapshot()).totals.sent).toBe(1);
  expect(await coordinator.ingest(counted.db, f.id, f.token, metrics(3, f.now + 300_000), f.now + 300_000)).toBe("ok"); expect((await f.snapshot()).totals.sent).toBe(3);
});
it("rebases a competing isolate's buffered counters before persisting its urgent error", async () => {
  const f = await fixture(), a = createDeploymentIngest(), b = createDeploymentIngest();
  await a.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now); await b.authenticate(env.DB, f.id, f.token, f.now);
  await b.ingest(env.DB, f.id, f.token, metrics(2, f.now + 1000), f.now + 1000);
  await a.ingest(env.DB, f.id, f.token, errors(1, f.now + 2000), f.now + 2000);
  await b.ingest(env.DB, f.id, f.token, errors(2, f.now + 3000), f.now + 3000);
  expect(await f.snapshot()).toMatchObject({ totals: { sent: 2, errors: 2 } });
});
it("does not roll back newer counters when a stale isolate sends an older urgent batch", async () => {
  const f = await fixture(), a = createDeploymentIngest(), b = createDeploymentIngest();
  await a.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now); await b.authenticate(env.DB, f.id, f.token, f.now);
  await a.ingest(env.DB, f.id, f.token, [...metrics(10, f.now + 3000), ...errors(3, f.now + 3000)], f.now + 3000);
  await b.ingest(env.DB, f.id, f.token, [...metrics(2, f.now + 1000), ...errors(1, f.now + 1000)], f.now + 4000);
  expect(await f.snapshot()).toMatchObject({ totals: { sent: 10, errors: 3 } });
});
it("refreshes a losing checkpoint baseline so subsequent requests do not query D1 again", async () => {
  const f = await fixture(), a = createDeploymentIngest(), b = createDeploymentIngest(), counted = countDatabase();
  await a.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now); await b.authenticate(counted.db, f.id, f.token, f.now);
  await a.ingest(env.DB, f.id, f.token, metrics(3, f.now + 300_000), f.now + 300_000);
  await b.ingest(counted.db, f.id, f.token, metrics(2, f.now + 299_000), f.now + 300_001);
  const count = counted.calls.length; await b.ingest(counted.db, f.id, f.token, metrics(4, f.now + 301_000), f.now + 301_000); expect(counted.calls).toHaveLength(count);
});
it.each(["pending", "crashed"])("makes metrics-only %s deployments live without a second heartbeat write", async status => {
  const f = await fixture(status), coordinator = createDeploymentIngest(), counted = countDatabase();
  await coordinator.ingest(counted.db, f.id, f.token, metrics(1, f.now), f.now); expect((await f.read())?.status).toBe("running");
  expect(counted.calls.filter(query => query.startsWith("UPDATE"))).toHaveLength(1);
});
it("coalesces heartbeat races and refreshes the losing isolate's liveness baseline", async () => {
  const f = await fixture(), a = createDeploymentIngest(), b = createDeploymentIngest(), counted = countDatabase();
  await a.authenticate(env.DB, f.id, f.token, f.now); await b.authenticate(counted.db, f.id, f.token, f.now);
  await a.ingest(env.DB, f.id, f.token, [], f.now); await b.ingest(counted.db, f.id, f.token, [], f.now + 1);
  const count = counted.calls.length; await b.ingest(counted.db, f.id, f.token, [], f.now + 1000); expect(counted.calls).toHaveLength(count);
});
it("serializes concurrent requests within one isolate without losing urgent observations", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest();
  await Promise.all([coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now), coordinator.ingest(env.DB, f.id, f.token, errors(1, f.now + 1), f.now + 1), coordinator.ingest(env.DB, f.id, f.token, errors(2, f.now + 2), f.now + 2)]);
  expect(await f.snapshot()).toMatchObject({ totals: { sent: 1, errors: 2 } });
});
it("does not forget an urgent checkpoint after D1 failure and releases the local request lock", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(); await coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now);
  const failing = { prepare() { throw new Error("D1 fixture unavailable"); } } as unknown as D1Database;
  await expect(coordinator.ingest(failing, f.id, f.token, errors(1, f.now + 1), f.now + 1)).rejects.toThrow("D1 fixture unavailable");
  await coordinator.ingest(env.DB, f.id, f.token, errors(1, f.now + 1), f.now + 2); expect((await f.snapshot()).totals.errors).toBe(1);
});
it("persists sent-counter resets immediately to preserve lifetime accumulation", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(); await coordinator.ingest(env.DB, f.id, f.token, metrics(2, f.now), f.now);
  await coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now + 1), f.now + 1); expect(await f.snapshot()).toMatchObject({ totals: { sent: 1 }, lifetimeOffset: { sent: 2 } });
});
it("expires auth caches and handles token rotation, missing tokens and removed deployments", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest({ ttlMs: 100 });
  expect(await coordinator.authenticate(env.DB, "missing", f.token, f.now)).toBe("not_found"); expect(await coordinator.authenticate(env.DB, f.id, "wrong", f.now)).toBe("invalid_token");
  await coordinator.authenticate(env.DB, f.id, f.token, f.now); await env.DB.prepare("UPDATE deployments SET heartbeat_token='new' WHERE id=?").bind(f.id).run();
  expect(await coordinator.authenticate(env.DB, f.id, "new", f.now + 1)).toBe("ok"); expect(await coordinator.authenticate(env.DB, f.id, f.token, f.now + 2)).toBe("invalid_token");
  await coordinator.authenticate(env.DB, f.id, "new", f.now + 3); await env.DB.prepare("UPDATE deployments SET heartbeat_token=NULL WHERE id=?").bind(f.id).run();
  expect(await coordinator.authenticate(env.DB, f.id, "new", f.now + 103)).toBe("not_found");
});
it("refuses a rotated credential during a cached checkpoint instead of persisting its observations", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(); await coordinator.authenticate(env.DB, f.id, f.token, f.now);
  await env.DB.prepare("UPDATE deployments SET heartbeat_token='new' WHERE id=?").bind(f.id).run(); expect(await coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now)).toBe("invalid_token"); expect((await f.read())?.metrics_snapshot_json).toBeNull();
});
it("repairs malformed persisted JSON on a fresh checkpoint", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(); await env.DB.prepare("UPDATE deployments SET metrics_snapshot_json='broken' WHERE id=?").bind(f.id).run();
  expect(await coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now)).toBe("ok"); expect((await f.snapshot()).totals.sent).toBe(1);
});
it("retains buffered absolute counters when refreshing an expired token cache", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest({ ttlMs: 100, checkpointMs: 1000 });
  await coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now); await coordinator.ingest(env.DB, f.id, f.token, metrics(2, f.now + 10), f.now + 10);
  await coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now + 101, "received"), f.now + 101);
  await coordinator.ingest(env.DB, f.id, f.token, metrics(2, f.now + 1000, "received"), f.now + 1000);
  expect(await f.snapshot()).toMatchObject({ totals: { sent: 2, received: 2 } });
});
it("evicts the least recently accessed cache entry at its bound and prunes expired entries", async () => {
  const a = await fixture(), b = await fixture(), c = await fixture(), coordinator = createDeploymentIngest({ maxEntries: 2, ttlMs: 100 }), counted = countDatabase();
  await coordinator.authenticate(counted.db, a.id, a.token, a.now); await coordinator.authenticate(counted.db, b.id, b.token, a.now + 1);
  await coordinator.authenticate(counted.db, a.id, a.token, a.now + 2); await coordinator.authenticate(counted.db, c.id, c.token, a.now + 3);
  const count = counted.calls.length; await coordinator.authenticate(counted.db, a.id, a.token, a.now + 4); expect(counted.calls).toHaveLength(count);
  await coordinator.authenticate(counted.db, b.id, b.token, a.now + 5); expect(counted.calls).toHaveLength(count + 1);
  await coordinator.authenticate(counted.db, c.id, c.token, a.now + 200); expect(counted.calls).toHaveLength(count + 2);
});
it("refuses deleted deployments after a cached metrics or heartbeat checkpoint loses its row", async () => {
  for (const events of [metrics(1, Date.now()), []]) {
    const f = await fixture(), coordinator = createDeploymentIngest(); await coordinator.authenticate(env.DB, f.id, f.token, f.now);
    await env.DB.prepare("DELETE FROM deployments WHERE id=?").bind(f.id).run(); expect(await coordinator.ingest(env.DB, f.id, f.token, events, f.now)).toBe("not_found");
  }
});
it("preserves newer stored liveness when a request clock moves backwards", async () => {
  const f = await fixture("crashed"), coordinator = createDeploymentIngest(); await env.DB.prepare("UPDATE deployments SET last_seen_at=? WHERE id=?").bind(f.now + 1000, f.id).run();
  await coordinator.ingest(env.DB, f.id, f.token, [], f.now); expect((await f.read())?.last_seen_at).toBe(f.now + 1000); expect((await f.read())?.status).toBe("running");
});
it("bounds conflict recovery and resumes after three actual competing D1 writers", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(), writer = createDeploymentIngest(); let collisions = 0;
  const racing = { prepare(query: string) {
    const prepared = env.DB.prepare(query); if (!query.startsWith("UPDATE deployments SET metrics_snapshot_json")) return prepared;
    return { bind(...values: unknown[]) { const bound = prepared.bind(...values); return { async run() { collisions++; await writer.ingest(env.DB, f.id, f.token, metrics(1, f.now + collisions, "sent", `writer_${collisions}`), f.now + collisions); return bound.run(); } }; } } as unknown as D1PreparedStatement;
  } } as D1Database;
  expect(await coordinator.ingest(racing, f.id, f.token, errors(1, f.now), f.now)).toBe("busy"); expect(collisions).toBe(3);
  await coordinator.ingest(env.DB, f.id, f.token, errors(1, f.now), f.now + 4); expect(await f.snapshot()).toMatchObject({ totals: { sent: 3, errors: 1 } });
});
it("coalesces ordinary discarded counters until the checkpoint is due", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(), counted = countDatabase();
  await coordinator.ingest(counted.db, f.id, f.token, metrics(1, f.now, "discarded", "filter"), f.now);
  const initial = counted.calls.length;
  for (let i = 2; i <= 30; i++) await coordinator.ingest(counted.db, f.id, f.token, metrics(i, f.now + i, "discarded", "filter"), f.now + i);
  expect(counted.calls).toHaveLength(initial);
  expect((await f.snapshot()).totals.discarded).toBe(1);
  await coordinator.ingest(counted.db, f.id, f.token, metrics(31, f.now + 300_000, "discarded", "filter"), f.now + 300_000);
  expect((await f.snapshot()).totals.discarded).toBe(31);
  expect(counted.calls.filter(sql => sql.startsWith("UPDATE"))).toHaveLength(2);
});
it("accepts a final collision when its winning writer already persisted the error sample", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(), writer = createDeploymentIngest(); let collisions = 0;
  const racing = { prepare(query: string) {
    const prepared = env.DB.prepare(query); if (!query.startsWith("UPDATE deployments SET metrics_snapshot_json")) return prepared;
    return { bind(...values: unknown[]) { const bound = prepared.bind(...values); return { async run() {
      collisions++; await writer.ingest(env.DB, f.id, f.token, [...metrics(1, f.now + collisions, "sent", `writer_${collisions}`), ...(collisions === 3 ? errors(1, f.now) : [])], f.now + collisions);
      return bound.run();
    } }; } } as unknown as D1PreparedStatement;
  } } as D1Database;
  expect(await coordinator.ingest(racing, f.id, f.token, errors(1, f.now), f.now)).toBe("ok");
  expect(collisions).toBe(3);expect(await f.snapshot()).toMatchObject({totals:{sent:3,errors:1}});
});
it("returns retryable metrics contention and persists the retained sample on retry without logging an exception", async () => {
  const f = await fixture(), writer = createDeploymentIngest();let collisions = 0;
  const racing = { prepare(query: string) {
    const prepared = env.DB.prepare(query);if (!query.startsWith("UPDATE deployments SET metrics_snapshot_json")) return prepared;
    return {bind(...values:unknown[]){const bound=prepared.bind(...values);return {async run(){
      collisions++;await writer.ingest(env.DB,f.id,f.token,metrics(1,f.now+collisions,"sent",`writer_${collisions}`),f.now+collisions);return bound.run();
    }};}} as unknown as D1PreparedStatement;
  }} as D1Database;
  const context=createExecutionContext(),log=vi.spyOn(console,"error"),request=()=>new Request(`https://local.test/api/metrics/${f.id}`,{method:"POST",headers:{authorization:`Bearer ${f.token}`,"content-type":"application/json"},body:JSON.stringify({name:"component_errors_total",timestamp:f.now,counter:{value:1},tags:{component_id:"sink",error_type:"http"}})});
  const busy=await worker.fetch(request(),{...env,DB:racing},context);await waitOnExecutionContext(context);
  expect(busy.status).toBe(503);expect(busy.headers.get("Retry-After")).toBe("1");expect(await busy.json()).toEqual({error:"metrics_checkpoint_busy"});expect(collisions).toBe(3);expect(log).not.toHaveBeenCalled();
  const retryContext=createExecutionContext(),retried=await worker.fetch(request(),env,retryContext);await waitOnExecutionContext(retryContext);
  expect(retried.status).toBe(204);expect(await f.snapshot()).toMatchObject({totals:{sent:3,errors:1}});expect(log).not.toHaveBeenCalled();log.mockRestore();
});
it("refreshes cached authorization on a backwards cache clock", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(), counted = countDatabase(); await coordinator.authenticate(counted.db, f.id, f.token, f.now);
  await coordinator.authenticate(counted.db, f.id, f.token, f.now - 1); expect(counted.calls).toHaveLength(2);
});
it("does not evict buffered authorized observations when another client presents an invalid token", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(), counted = countDatabase();
  await coordinator.ingest(counted.db, f.id, f.token, metrics(1, f.now), f.now); await coordinator.ingest(counted.db, f.id, f.token, metrics(2, f.now + 1), f.now + 1);
  expect(await coordinator.authenticate(counted.db, f.id, "wrong", f.now + 2)).toBe("invalid_token");
  const count = counted.calls.length; await coordinator.ingest(counted.db, f.id, f.token, [], f.now + 3); expect(counted.calls).toHaveLength(count);
  await coordinator.ingest(env.DB, f.id, f.token, errors(1, f.now + 4), f.now + 4); expect(await f.snapshot()).toMatchObject({ totals: { sent: 2, errors: 1 } });
});
it.each(["null", "{}", "0"])("repairs incomplete persisted snapshot %s without crashing ingestion", async raw => {
  const f = await fixture(), coordinator = createDeploymentIngest(); await env.DB.prepare("UPDATE deployments SET metrics_snapshot_json=? WHERE id=?").bind(raw, f.id).run();
  expect(await coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now)).toBe("ok"); expect((await f.snapshot()).totals.sent).toBe(1);
});
it("does not roll back a newer process epoch when an old isolate delivers buffered metrics", async () => {
  const f = await fixture(), a = createDeploymentIngest(), b = createDeploymentIngest();
  const uptime = (time: number, seconds: number) => parseMetricsBody(JSON.stringify({ name: "vector_uptime_seconds", timestamp: time, gauge: { value: seconds } }));
  await a.ingest(env.DB, f.id, f.token, [...metrics(1, f.now), ...uptime(f.now, 60)], f.now); await b.authenticate(env.DB, f.id, f.token, f.now);
  await b.ingest(env.DB, f.id, f.token, [...metrics(2, f.now + 1000), ...uptime(f.now + 1000, 61)], f.now + 1000);
  await a.ingest(env.DB, f.id, f.token, [...metrics(1, f.now + 120_000), ...uptime(f.now + 120_000, 1)], f.now + 120_000);
  const before = (await f.read())!.metrics_snapshot_json;
  await b.ingest(env.DB, f.id, f.token, errors(1, f.now + 1000), f.now + 121_000); expect((await f.read())!.metrics_snapshot_json).toBe(before);
  expect((await f.snapshot()).processStartAt).toBe(f.now + 119_000);
});
it("buffers only recognized accepted identities and ignores replayed or unsupported observations", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest({ ttlMs: 100, checkpointMs: 1000 });
  await coordinator.ingest(env.DB, f.id, f.token, [...metrics(1, f.now), ...errors(1, f.now)], f.now);
  const noise = parseMetricsBody(JSON.stringify([
    { name: "unsupported", counter: { value: 1 }, timestamp: f.now + 1 },
    { name: "component_sent_events_total", gauge: { value: 9 }, timestamp: f.now + 1, tags: { component_id: "sink" } },
    { name: "component_sent_events_total", counter: { value: 9 }, timestamp: f.now + 1 },
    { name: "uptime_seconds", counter: { value: 9 }, timestamp: f.now + 1 },
    { name: "build_info", gauge: { value: 1 }, timestamp: f.now + 1 },
  ]));
  await coordinator.ingest(env.DB, f.id, f.token, noise, f.now + 1);
  const newer = metrics(2, f.now + 2); await coordinator.ingest(env.DB, f.id, f.token, newer, f.now + 2); await coordinator.ingest(env.DB, f.id, f.token, newer, f.now + 3);
  await coordinator.ingest(env.DB, f.id, f.token, errors(1, f.now), f.now + 101);
  await coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now + 1000, "received"), f.now + 1000); expect(await f.snapshot()).toMatchObject({ totals: { sent: 2, errors: 1, received: 1 } });
});
it("keeps explicit stopped status while recording a metrics checkpoint", async () => {
  const f = await fixture("stopped"), coordinator = createDeploymentIngest(); await coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now); expect((await f.read())?.status).toBe("stopped");
});
it("repairs invalid snapshot counters, epochs and cardinality rather than propagating incomplete totals", async () => {
  const f = await fixture(), coordinator = createDeploymentIngest(); await coordinator.ingest(env.DB, f.id, f.token, metrics(1, f.now), f.now); const good = await f.snapshot();
  for (const broken of [{ ...good, totals: {} }, { ...good, lifetimeOffset: { ...good.lifetimeOffset, errors: -1 } }, { ...good, processStartAt: "invalid" }, { ...good, byComponent: { sink: null } }, { ...good, byComponent: { sink: { ...good.byComponent.sink, errorsByType: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i), 1])) } } }, { ...good, byComponent: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), good.byComponent.sink])) }]) {
    await env.DB.prepare("UPDATE deployments SET metrics_snapshot_json=? WHERE id=?").bind(JSON.stringify(broken), f.id).run();
    const isolated = createDeploymentIngest(); expect(await isolated.ingest(env.DB, f.id, f.token, metrics(2, f.now + 1), f.now + 1)).toBe("ok"); expect((await f.snapshot()).totals.sent).toBe(2);
  }
});
