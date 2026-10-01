/** The same black-box scenario runs through SELF or a local/remote HTTP server. */
export interface LifecycleTarget {
  baseUrl: string;
  fetch: (request: Request) => Promise<Response>;
  sessionCookie: string;
  expectedUserId: string;
  runId: string;
}

export async function runRoutingLifecycle(target: LifecycleTarget): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(target.runId)) throw new Error("invalid E2E run ID");
  const prefix = `e2e-${target.runId}-`;
  const ledger: Array<{ path: string; kind: string; id: string }> = [];
  async function request(path: string, init: RequestInit = {}, status = 200): Promise<any> {
    const headers = new Headers(init.headers);
    headers.set("cookie", target.sessionCookie);
    const response = await target.fetch(new Request(new URL(path, target.baseUrl), { ...init, headers }));
    if (response.status !== status) throw new Error(`${init.method ?? "GET"} ${path}: expected ${status}, got ${response.status}`);
    return response.json();
  }
  const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  const me = await request("/api/me");
  check(me.user?.id === target.expectedUserId, "E2E account identity mismatch");
  const baselineMonitors = await request("/api/monitors");
  const baselineDestinations = await request("/api/destinations");
  let failure: unknown;
  try {
    await request("/api/monitors", json({}), 400);
    await request("/api/monitors/missing-e2e-monitor", json({ displayName: prefix + "missing" }, "PUT"), 404);
    const form = new FormData();
    form.set("kind", "webhook"); form.set("display_name", prefix + "webhook"); form.set("url", "https://example.invalid/logtura-e2e");
    const { destination } = await request("/api/destinations", { method: "POST", body: form });
    check(destination.displayName === prefix + "webhook", "destination name was not preserved");
    ledger.push({ path: `/api/destinations/${destination.id}`, kind: "destinations", id: destination.id });
    const { monitor } = await request("/api/monitors", json({ displayName: prefix + "monitor", filterSteps: [{ kind: "errors" }] }));
    ledger.push({ path: `/api/monitors/${monitor.id}`, kind: "monitors", id: monitor.id });
    check((await request("/api/monitors")).monitors.some((m: any) => m.id === monitor.id), "created monitor missing");
    const { sink } = await request(`/api/monitors/${monitor.id}/sinks`, json({ destinationId: destination.id, filterSteps: [] }));
    await request(`/api/sinks/${sink.id}`, json({ filterSteps: [{ kind: "errors" }] }, "PUT"));
    const updated = await request(`/api/monitors/${monitor.id}`, json({ displayName: prefix + "updated", enabled: false }, "PUT"));
    check(updated.monitor.displayName === prefix + "updated" && updated.monitor.enabled === false, "monitor update was not persisted");
    await request(`/api/sinks/${sink.id}`, { method: "DELETE" });
    const detail = await request("/api/monitors");
    check(!detail.sinks.some((s: any) => s.id === sink.id), "deleted sink remains attached");
  } catch (error) { failure = error; }
  const cleanupFailures: string[] = [];
  for (const resource of ledger.reverse()) {
    try {
      const current = await request(`/api/${resource.kind}`);
      const owned = current[resource.kind].find((r: any) => r.id === resource.id);
      if (!owned) continue;
      check(owned.displayName.startsWith(prefix), "resource does not belong to this E2E run");
      await request(resource.path, { method: "DELETE" });
      await request(resource.path, { method: "DELETE" }); // Cleanup must be idempotent.
      const after = await request(`/api/${resource.kind}`);
      check(!after[resource.kind].some((r: any) => r.id === resource.id), "cleanup did not remove resource");
    } catch { cleanupFailures.push(resource.path); }
  }
  const monitors = await request("/api/monitors");
  const destinations = await request("/api/destinations");
  check(baselineMonitors.monitors.every((r: any) => monitors.monitors.some((m: any) => m.id === r.id)), "pre-existing monitor removed");
  check(baselineDestinations.destinations.every((r: any) => destinations.destinations.some((d: any) => d.id === r.id)), "pre-existing destination removed");
  if (cleanupFailures.length) throw new Error(`E2E cleanup failed: ${cleanupFailures.join(", ")}`, { cause: failure });
  if (failure) throw failure;
}
