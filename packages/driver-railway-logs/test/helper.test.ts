import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { railwayLogsDriver } from "../src/index";

const asset = railwayLogsDriver.generatePipeline({ connection: { id: "con", externalAccountId: "production", displayName: "Railway" }, selection: { kind: "list", sources: [{ id: "api", externalId: "api", sourceKind: "railway_service", displayName: "API", metadata: null }] } }).runtimeAssets![0]!.content;
async function execute(token: string, frames: unknown[], fetch?: typeof globalThis.fetch) {
  const events: Array<Record<string, any>> = [], sent: Array<Record<string, any>> = [], connections: Array<{ url: string; options: any }> = [], errors: string[] = [];
  class Socket {
    onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void;
    constructor(url: string, options: unknown) { connections.push({ url, options }); queueMicrotask(() => { this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: "connection_ack" }) }); }); }
    send(value: string) { const message = JSON.parse(value); sent.push(message); if (message.type === "subscribe") queueMicrotask(() => { for (const frame of frames) this.onmessage?.({ data: JSON.stringify(frame) }); this.onmessage?.({ data: JSON.stringify({ type: "complete" }) }); }); }
    close() { this.onclose?.(); }
  }
  const result = runInNewContext(`(async () => { ${asset}\n})()`, {
    process: { argv: ["bun", "helper.mjs", "production", '[{"id":"api","name":"API"}]'], env: { RAILWAY_API_TOKEN: token }, stdout: { write(value: string) { events.push(JSON.parse(value)); } }, exit(code: number) { throw new Error(`exit ${code}`); } },
    console: { error(message: string) { errors.push(message); } }, WebSocket: Socket, fetch, queueMicrotask,
    // Keep the production stream window/reconnect timers inert without leaving
    // native timers behind. WebSocket completion ends this fixture subscription.
    setTimeout() { return 1; }, clearTimeout() {},
  }) as Promise<void>;
  result.catch(() => {});
  await vi.waitFor(() => expect(sent.some(message => message.type === "complete") || events.length || errors.length).toBeTruthy());
  return { events, sent, connections, errors, result };
}
const row = { timestamp: "2026-10-02T00:00:00Z", message: "Provider failure", severity: "error", tags: { serviceId: "api", projectId: "shop", deploymentId: "deploy", deploymentInstanceId: "instance" }, attributes: [{ key: "count", value: "3" }, { key: "structured", value: '{"ok":true}' }, { key: "level", value: "error" }, { key: "flag", value: false }, null, {}] };
it("executes the emitted helper's authenticated subscription, demultiplexing, attribute parsing and replay deduplication", async () => {
  const run = await execute("account-fixture", [{ type: "ping", payload: { ping: "fixture" } }, { type: "next", payload: { data: { environmentLogs: [row, row, { ...row, tags: { serviceId: "worker" } }, { ...row, tags: {} }] } } }]);
  expect(run.connections).toEqual([{ url: "wss://backboard.railway.com/graphql/v2", options: { protocols: ["graphql-transport-ws"], headers: { authorization: "Bearer account-fixture" } } }]);
  expect(run.sent[0]).toEqual({ type: "connection_init" });
  expect(run.sent.find(message => message.type === "pong")).toEqual({ type: "pong", payload: { ping: "fixture" } });
  const subscription = run.sent.find(message => message.type === "subscribe")!;
  expect(subscription.payload.variables).toMatchObject({ environmentId: "production", filter: "", afterLimit: 500 });
  expect(Date.parse(subscription.payload.variables.afterDate) - Date.parse(subscription.payload.variables.anchorDate)).toBeGreaterThanOrEqual(3_600_000);
  expect(subscription.payload.query).toContain("environmentLogs(environmentId:");
  expect(run.events).toHaveLength(1);
  expect(run.events[0]).toMatchObject({ serviceId: "api", serviceName: "API", environmentId: "production", projectId: "shop", deploymentId: "deploy", deploymentInstanceId: "instance", snapshotId: null, attrs: { count: 3, structured: { ok: true }, level: "error", flag: false } });
});
it.each(["p_fixture", "project_fixture"])("uses a project header in the emitted helper for %s", async token => {
  const run = await execute(token, []);
  expect(run.connections[0]?.options.headers).toEqual({ "project-access-token": token });
});
it("executes the service token broker exchange before subscription without sending the fragment in the URL", async () => {
  const fetch = vi.fn(async () => Response.json({ access_token: "oauth-fixture", expires_in: 300 }));
  const run = await execute("https://fixture.invalid/token#tail-fixture", [], fetch);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("https://fixture.invalid/token", { method: "POST", headers: { authorization: "Bearer tail-fixture", accept: "application/json" } });
  expect(run.connections[0]?.options.headers).toEqual({ authorization: "Bearer oauth-fixture" });
});
it("emits a structured cooldown-limited helper error for subscription failures", async () => {
  const run = await execute("account-fixture", [{ type: "next", payload: { errors: [{ message: "No scope" }] } }, { type: "next", payload: { errors: [{ message: "No scope" }] } }]);
  expect(run.events).toHaveLength(1);
  expect(run.events[0]).toMatchObject({ level: "error", severity: "error", source: "logtura_railway_helper", environmentId: "production", message: "railway environment log tail: No scope", helperErrorSuppressed: 0, helperErrorCooldownMs: 300_000 });
});
it("refuses missing helper credentials before opening a socket", async () => {
  const run = await execute("", []);
  await expect(run.result).rejects.toThrow("exit 1");
  expect(run.errors).toEqual(["RAILWAY_API_TOKEN is required"]); expect(run.connections).toEqual([]);
});
