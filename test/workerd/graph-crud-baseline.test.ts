import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../../src/index";
import { createConnection, createDestination, createMonitor, createSink, createDeployment, getMonitor, listSinksForMonitor, DEFAULT_SINK_STEPS } from "../../src/db";
import { readConfigurationVersion } from "../../src/config-version";
import { seedUser } from "./_setup";
const steps = [{ kind: "errors" }, { kind: "level", level: "error", mode: "exclude" }, { kind: "match", pattern: "timeout", mode: "include", field: "message" }, { kind: "dedup", window_secs: 45, fields: ["message"] }, { kind: "rate_limit", per_minute: 10 }, { kind: "sample", rate: 2 }, { kind: "rollup", window_secs: 30, group_by: ["site"], max_samples: 3 }];
async function request(path: string, cookie: string | undefined, method = "GET", body?: unknown, raw = false) {
  const context = createExecutionContext(), headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await worker.fetch(new Request(`http://localhost/api${path}`, { method, headers, body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body) }), env, context);
  await waitOnExecutionContext(context);
  return response;
}
async function fixture() {
  const user = await seedUser();
  const connection = await createConnection(env.DB, env, { userId: user.userId, provider: "cloudflare-worker-tail", displayName: "Account", externalAccountId: "account", credentials: { apiToken: "fixture-private-token" } });
  const destination = await createDestination(env.DB, env, { userId: user.userId, kind: "webhook", displayName: "Alerts", config: { url: "https://private.test/hook" } });
  const monitor = await createMonitor(env.DB, { userId: user.userId, connectionId: connection.id, displayName: "Existing", filterSteps: [{ kind: "errors" }] });
  const sink = await createSink(env.DB, { monitorId: monitor.id, destinationId: destination.id });
  const deployment = await createDeployment(env.DB, { userId: user.userId, connectionId: connection.id, displayName: "Forwarder", targetKind: "other" });
  await env.DB.prepare("UPDATE deployments SET bundle_outdated=0 WHERE id=?").bind(deployment.id).run();
  return { ...user, connection, destination, monitor, sink, deployment };
}
it("creates, edits and deletes scoped monitors and sinks while advancing the graph and invalidating the forwarder", async () => {
  const own = await fixture(), foreign = await fixture(), initialVersion = await readConfigurationVersion(env.DB, own.userId);
  let response = await request("/monitors", own.sessionCookie, "POST", { displayName: "Website pipeline", connectionId: own.connection.id, enabled: false, filterSteps: steps });
  expect(response.status).toBe(200);
  const monitor = (await response.json()) as any;
  expect(monitor.monitor).toMatchObject({ displayName: "Website pipeline", connectionId: own.connection.id, enabled: false, filterSteps: steps });
  expect(await readConfigurationVersion(env.DB, own.userId)).toBeGreaterThan(initialVersion);
  expect(await env.DB.prepare("SELECT bundle_outdated FROM deployments WHERE id=?").bind(own.deployment.id).first("bundle_outdated")).toBe(1);
  expect(await env.DB.prepare("SELECT bundle_outdated FROM deployments WHERE id=?").bind(foreign.deployment.id).first("bundle_outdated")).toBe(0);
  const id = monitor.monitor.id;
  response = await request(`/monitors/${id}`, own.sessionCookie, "PUT", { displayName: "Changed pipeline", connectionId: null, enabled: true, filterSteps: [] });
  expect((await response.json() as any).monitor).toMatchObject({ displayName: "Changed pipeline", connectionId: null, enabled: true, filterSteps: [] });
  expect((await request(`/monitors/${id}`, own.sessionCookie, "PUT", {})).status).toBe(200);
  response = await request(`/monitors/${id}/sinks`, own.sessionCookie, "POST", { destinationId: own.destination.id });
  const createdSink = (await response.json() as any).sink;
  expect(createdSink.filterSteps).toEqual(DEFAULT_SINK_STEPS);
  expect((await request(`/sinks/${createdSink.id}`, own.sessionCookie, "PUT", { filterSteps: steps })).status).toBe(200);
  response = await request("/monitors", own.sessionCookie);
  const listed = await response.json() as any;
  expect(listed.sinks.find((sink: any) => sink.id === createdSink.id).filterSteps).toEqual(steps);
  expect(listed.monitors.some((row: any) => row.id === foreign.monitor.id)).toBe(false);
  expect(JSON.stringify(listed)).not.toContain("fixture-private-token");
  expect((await request(`/sinks/${createdSink.id}`, own.sessionCookie, "PUT", {})).status).toBe(200);
  expect((await request(`/sinks/${createdSink.id}`, own.sessionCookie, "DELETE")).status).toBe(200);
  expect(await listSinksForMonitor(env.DB, id)).toEqual([]);
  expect((await request(`/monitors/${id}/sinks`, own.sessionCookie, "POST", { destinationId: own.destination.id, filterSteps: [] })).status).toBe(200);
  expect((await request(`/monitors/${id}`, own.sessionCookie, "DELETE")).status).toBe(200);
  expect(await getMonitor(env.DB, own.userId, id)).toBeNull();
  expect(await listSinksForMonitor(env.DB, id)).toEqual([]);
});
it("preserves default all-connection monitors and partial updates", async () => {
  const own = await fixture();
  const response = await request("/monitors", own.sessionCookie, "POST", { displayName: "All sources" });
  const monitor = (await response.json() as any).monitor;
  expect(monitor).toMatchObject({ connectionId: null, enabled: true, filterSteps: [] });
  const updated = await request(`/monitors/${monitor.id}`, own.sessionCookie, "PUT", { connectionId: own.connection.id, enabled: false });
  expect((await updated.json() as any).monitor).toMatchObject({ displayName: "All sources", connectionId: own.connection.id, enabled: false, filterSteps: [] });
});
it("rejects foreign and missing connection references before monitor creation or update", async () => {
  const own = await fixture(), foreign = await fixture(), before = await getMonitor(env.DB, own.userId, own.monitor.id), version = await readConfigurationVersion(env.DB, own.userId);
  for (const connectionId of [foreign.connection.id, "con_missing"]) {
    for (const [path, method] of [["/monitors", "POST"], [`/monitors/${own.monitor.id}`, "PUT"]]) {
      const response = await request(path!, own.sessionCookie, method, { displayName: "Must not save", connectionId });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "connection_not_found" });
    }
  }
  expect(await getMonitor(env.DB, own.userId, own.monitor.id)).toEqual(before);
  expect(await readConfigurationVersion(env.DB, own.userId)).toBe(version);
  expect(await env.DB.prepare("SELECT COUNT(*) FROM monitors WHERE user_id=?").bind(own.userId).first("COUNT(*)")).toBe(1);
});
it("scopes missing/foreign monitors and destination references without revealing or changing other users' entities", async () => {
  const own = await fixture(), foreign = await fixture();
  for (const id of [foreign.monitor.id, "mon_missing"]) {
    expect((await request(`/monitors/${id}`, own.sessionCookie, "PUT", { displayName: "Foreign change" })).status).toBe(404);
    expect((await request(`/monitors/${id}/sinks`, own.sessionCookie, "POST", { destinationId: own.destination.id })).status).toBe(404);
    expect((await request(`/monitors/${id}`, own.sessionCookie, "DELETE")).status).toBe(200);
  }
  for (const destinationId of [foreign.destination.id, "dst_missing"]) {
    const response = await request(`/monitors/${own.monitor.id}/sinks`, own.sessionCookie, "POST", { destinationId });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "destination_not_found" });
  }
  const before = await listSinksForMonitor(env.DB, foreign.monitor.id);
  expect((await request(`/sinks/${foreign.sink.id}`, own.sessionCookie, "PUT", { filterSteps: [] })).status).toBe(200);
  expect((await request(`/sinks/${foreign.sink.id}`, own.sessionCookie, "DELETE")).status).toBe(200);
  expect(await listSinksForMonitor(env.DB, foreign.monitor.id)).toEqual(before);
  expect((await getMonitor(env.DB, foreign.userId, foreign.monitor.id))!.display_name).toBe("Existing");
});
it("rejects malformed monitor/sink JSON and fields without graph writes", async () => {
  const own = await fixture(), version = await readConfigurationVersion(env.DB, own.userId);
  const badFilters = [null, {}, [null], [{ kind: "unknown" }], [{ kind: "errors", secret: "fixture-private-filter" }], [{ kind: "dedup", window_secs: 0 }]];
  const badMonitors = [null, [], 42, { unknown: "fixture-private-filter" }, { displayName: 42 }, { displayName: "" }, { displayName: " " }, { connectionId: 42 }, { connectionId: "" }, { enabled: 1 }, ...badFilters.map(filterSteps => ({ filterSteps }))];
  for (const input of badMonitors) {
    const response = await request(`/monitors/${own.monitor.id}`, own.sessionCookie, "PUT", input);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_form" });
  }
  expect(await (await request("/monitors", own.sessionCookie, "POST", {})).json()).toEqual({ error: "missing_fields" });
  for (const filterSteps of badFilters) {
    expect((await request("/monitors", own.sessionCookie, "POST", { displayName: "Bad", filterSteps })).status).toBe(400);
    expect((await request(`/monitors/${own.monitor.id}/sinks`, own.sessionCookie, "POST", { destinationId: own.destination.id, filterSteps })).status).toBe(400);
    expect((await request(`/sinks/${own.sink.id}`, own.sessionCookie, "PUT", { filterSteps })).status).toBe(400);
  }
  for (const input of [{}, { destinationId: "" }, { destinationId: 42 }, null, [], { destinationId: own.destination.id, unknown: "private" }]) {
    expect((await request(`/monitors/${own.monitor.id}/sinks`, own.sessionCookie, "POST", input)).status).toBe(400);
  }
  for (const [path, method] of [["/monitors", "POST"], [`/monitors/${own.monitor.id}`, "PUT"], [`/monitors/${own.monitor.id}/sinks`, "POST"], [`/sinks/${own.sink.id}`, "PUT"]]) {
    expect((await request(path!, own.sessionCookie, method, "{broken-private-json", true)).status).toBe(400);
  }
  expect((await request(`/sinks/${own.sink.id}`, own.sessionCookie, "PUT", { destinationId: own.destination.id })).status).toBe(400);
  expect(await readConfigurationVersion(env.DB, own.userId)).toBe(version);
  expect((await getMonitor(env.DB, own.userId, own.monitor.id))!.display_name).toBe("Existing");
});
it("requires authentication for every monitor/sink mutation and list", async () => {
  const own = await fixture();
  for (const [path, method] of [["/monitors", "GET"], ["/monitors", "POST"], [`/monitors/${own.monitor.id}`, "PUT"], [`/monitors/${own.monitor.id}`, "DELETE"], [`/monitors/${own.monitor.id}/sinks`, "POST"], [`/sinks/${own.sink.id}`, "PUT"], [`/sinks/${own.sink.id}`, "DELETE"]]) {
    expect((await request(path!, undefined, method, method === "GET" ? undefined : { displayName: "Must not save" })).status).toBe(303);
  }
});
