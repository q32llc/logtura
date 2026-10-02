import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  exportDeploymentManifest, createSecretVersioner, hashConfigDocument, LogturaServiceClient,
  ServiceError, type DeploymentConfigurationState, type DeploymentInstanceReceipt,
} from "@logtura/core";
import { activateLinkedDeployment, readPendingActivation, finishLinkedActivation, cancelRejectedLinkedActivation, abandonObsoleteLinkedActivation } from "../src/activation";
import { pendingActivationPath, pendingPushPath, deploymentLinkPath, assertNoPendingPush, commitFileTransaction } from "../src/file-transaction";
import { createDeploymentLink, deploymentStatus } from "../src/deployment-link";
import { writePulledConfig } from "../src/pull";
import { writeConfigDoc } from "../src/config";
import { pushDeploymentConfig } from "../src/push";
import { withPushLock } from "../src/push-lock";

vi.mock("node:fs", {spy: true});
const native = await vi.importActual<typeof fs>("node:fs");
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) native.rmSync(root, {recursive: true, force: true}); });
async function fixture(sequence = 1, service = "https://service.test") {
  const root = fs.mkdtempSync(join(tmpdir(), "logt-activation-")); roots.push(root);
  const config = join(root, "logt.yaml");
  const exported = await exportDeploymentManifest({providers: [], destinations: [], connections: [{connection: {id: "con_site", provider: "cloudflare-worker-tail", displayName: "Site", externalAccountId: "account"}, credentials: {apiToken: "private-value"}, selectedSources: []}], monitors: []}, await createSecretVersioner("service-private"));
  const revision = await hashConfigDocument(exported.document);
  const result = {...exported, revision, configurationVersion: 3, desiredSequence: sequence, deployment: {id: "dep_site", displayName: "Site"}};
  const link = await createDeploymentLink(service, "usr_site", result);
  await writePulledConfig(result, config, false, link);
  let state: DeploymentConfigurationState | null = {desired: {sequence, revision, document: exported.document, configurationVersion: 3}, applied: null, activeInstanceId: null, lastReportSequence: 0, stale: true};
  let receipt: DeploymentInstanceReceipt | null = null;
  const requests: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/me")) return Response.json({user: {id: "usr_site", githubLogin: "site"}});
    if (String(url).endsWith("/state")) return Response.json({state});
    if (init?.method === "POST") {
      const request = JSON.parse(init.body as string); requests.push(request);
      expect(fs.existsSync(pendingActivationPath(config))).toBe(true);
      expect(fs.statSync(pendingActivationPath(config)).mode & 0o777).toBe(0o600);
      expect(request.expectedInstanceId).toBe(state!.activeInstanceId);
      receipt = {requestId: request.requestId, instanceId: randomUUID(), configurationVersion: 3, sequence, revision};
      state!.activeInstanceId = receipt.instanceId;
      return Response.json(receipt);
    }
    return receipt ? Response.json(receipt) : Response.json({error: "receipt_not_found"}, {status: 404});
  });
  const client = (fetch: typeof globalThis.fetch = fetcher, url = link.service) => new LogturaServiceClient({url, token: `lt_cli_${"T".repeat(43)}`, fetch});
  const acknowledge = () => { state!.applied = {sequence, revision, at: Date.now()}; state!.lastReportSequence = 1; state!.stale = false; };
  return {root, config, link, result, client, fetcher, requests, acknowledge, get state() {return state;}, set state(value) {state = value;}, get receipt() {return receipt;}};
}
it("persists intent before activation, retains issued state until acknowledgement and blocks competing writers", async () => {
  const f = await fixture(); const receipt = await activateLinkedDeployment(f.client(), f.config);
  expect(await readPendingActivation(f.config)).toMatchObject({receipt, rejected: false});
  const reads = f.fetcher.mock.calls.length; expect(await deploymentStatus(f.config)).toMatchObject({pendingActivation: {phase: "issued", instanceId: receipt.instanceId, requestId: receipt.requestId}}); expect(f.fetcher.mock.calls.length).toBe(reads);
  expect(fs.readFileSync(pendingActivationPath(f.config), "utf8")).not.toContain("private-value");
  expect(() => assertNoPendingPush(f.config)).toThrow("Pending activation");
  expect(() => writeConfigDoc(f.config, {...f.result.document})).toThrow("Pending activation");
  await expect(writePulledConfig(f.result, f.config, true, f.link)).rejects.toThrow("Pending activation");
  await expect(pushDeploymentConfig(f.client(), f.config)).rejects.toThrow("Pending activation");
  await expect(activateLinkedDeployment(f.client(), f.config)).rejects.toThrow("Pending activation");
  await expect(finishLinkedActivation(f.client(), f.config)).rejects.toThrow("not acknowledged");
  expect(await activateLinkedDeployment(f.client(), f.config, {resume: true})).toEqual(receipt);
  expect(f.requests).toHaveLength(1);
  f.acknowledge(); await finishLinkedActivation(f.client(), f.config);
  expect(await readPendingActivation(f.config)).toBeNull(); expect(() => assertNoPendingPush(f.config)).not.toThrow();
});
it("recovers a committed lost response without issuing a second instance", async () => {
  const f = await fixture(); const lossy = f.client(async (url, init) => {const response = await f.fetcher(url, init); if (init?.method === "POST") throw new TypeError("lost response"); return response;});
  await expect(activateLinkedDeployment(lossy, f.config)).rejects.toThrow("lost response");
  const pending = (await readPendingActivation(f.config))!; expect(pending.receipt).toBeNull();
  expect(await deploymentStatus(f.config)).toMatchObject({pendingActivation: {phase: "pending", instanceId: null}});
  expect(await activateLinkedDeployment(f.client(), f.config, {resume: true})).toEqual(f.receipt);
  expect(f.requests).toHaveLength(1); expect(f.receipt!.requestId).toBe(pending.request.requestId);
  await expect(cancelRejectedLinkedActivation(f.client(), f.config)).rejects.toThrow("Only a rejected");
});
it("retries an uncommitted uncertain request with its same identity and fences replaced instances", async () => {
  const f = await fixture(); const offline = f.client(async (url, init) => {if (init?.method === "POST") throw new TypeError("offline"); return f.fetcher(url, init);});
  await expect(activateLinkedDeployment(offline, f.config)).rejects.toThrow("offline");
  const request = (await readPendingActivation(f.config))!.request;
  await expect(cancelRejectedLinkedActivation(f.client(), f.config)).rejects.toThrow("Only a rejected");
  await activateLinkedDeployment(f.client(), f.config, {resume: true}); expect(f.requests[0]).toEqual(request);
  f.state!.activeInstanceId = randomUUID();
  await expect(activateLinkedDeployment(f.client(), f.config, {resume: true})).rejects.toThrow("no longer current");
  await expect(finishLinkedActivation(f.client(), f.config)).rejects.toThrow("no longer current");
  expect(f.requests).toHaveLength(1); expect(fs.existsSync(pendingActivationPath(f.config))).toBe(true);
});
it("keeps definitive rejections pending and permits cancellation only after receipt lookup", async () => {
  for (const status of [400, 409]) {
    const f = await fixture(); const rejected = f.client(async (url, init) => init?.method === "POST" ? Response.json({error: "changed"}, {status}) : f.fetcher(url, init));
    await expect(activateLinkedDeployment(rejected, f.config)).rejects.toBeInstanceOf(ServiceError);
    expect((await readPendingActivation(f.config))!.rejected).toBe(true);
    expect(await deploymentStatus(f.config)).toMatchObject({pendingActivation: {phase: "rejected"}});
    await expect(activateLinkedDeployment(f.client(), f.config, {resume: true})).rejects.toThrow("Activation rejected");
    await cancelRejectedLinkedActivation(f.client(), f.config); expect(await readPendingActivation(f.config)).toBeNull();
  }
  const f = await fixture(); const rejected = f.client(async (url, init) => {const result = await f.fetcher(url, init); return init?.method === "POST" ? Response.json({error: "changed"}, {status: 409}) : result;});
  await expect(activateLinkedDeployment(rejected, f.config)).rejects.toThrow();
  await expect(cancelRejectedLinkedActivation(f.client(), f.config)).rejects.toThrow("Server has");
  expect(await activateLinkedDeployment(f.client(), f.config, {resume: true})).toEqual(f.receipt);
});
it("rejects foreign origin/account, missing links, legacy states and mismatched remote revisions before issuing", async () => {
  const f = await fixture(); await expect(activateLinkedDeployment(f.client(), f.config, {resume: true})).rejects.toThrow("No pending");
  await expect(activateLinkedDeployment(f.client(f.fetcher, "https://foreign.test"), f.config)).rejects.toThrow("origin");
  await expect(activateLinkedDeployment(f.client(async () => Response.json({user: {id: "wrong", githubLogin: "wrong"}})), f.config)).rejects.toThrow("account");
  for (const state of [null, {...f.state!, desired: {...f.state!.desired, sequence: 2}}, {...f.state!, desired: {...f.state!.desired, configurationVersion: 4}}]) {
    f.state = state; await expect(activateLinkedDeployment(f.client(), f.config)).rejects.toThrow("Remote configuration changed");
  }
  fs.rmSync(deploymentLinkPath(f.config)); await expect(activateLinkedDeployment(f.client(), f.config)).rejects.toThrow("Pull a hosted"); expect(f.requests).toHaveLength(0);
});
it("detects public/private baseline changes before writes and after asynchronous server calls", async () => {
  const f = await fixture(); fs.appendFileSync(join(f.root, ".env"), `\n${Object.keys(f.link.fingerprints)[0]}='{"apiToken":"changed"}'\n`);
  await expect(activateLinkedDeployment(f.client(), f.config)).rejects.toThrow("Private payload changed"); expect(f.requests).toHaveLength(0);
  const publicEdit = await fixture(); fs.writeFileSync(publicEdit.config, "kind: logtura.deployment\nschema_version: 1\n");
  await expect(activateLinkedDeployment(publicEdit.client(), publicEdit.config)).rejects.toThrow(); expect(publicEdit.requests).toHaveLength(0);
  const during = await fixture(); const changed = during.client(async (url, init) => {const result = await during.fetcher(url, init); if (String(url).endsWith("/state")) fs.rmSync(deploymentLinkPath(during.config)); return result;});
  await expect(activateLinkedDeployment(changed, during.config)).rejects.toThrow("Local configuration changed"); expect(during.requests).toHaveLength(0);
  const after = await fixture(); const edited = after.client(async (url, init) => {const result = await after.fetcher(url, init); if (init?.method === "POST") fs.rmSync(deploymentLinkPath(after.config)); return result;});
  await expect(activateLinkedDeployment(edited, after.config)).rejects.toThrow("Local configuration changed"); expect(after.requests).toHaveLength(1);
  expect(fs.existsSync(pendingActivationPath(after.config))).toBe(true);
  expect(await deploymentStatus(after.config)).toMatchObject({linked: false, pendingActivation: {phase: "issued"}});
});
it("refuses push journals and overlapping locks before activation", async () => {
  const f = await fixture(); fs.writeFileSync(pendingPushPath(f.config), "pending");
  await expect(activateLinkedDeployment(f.client(), f.config)).rejects.toThrow("Pending push"); fs.rmSync(pendingPushPath(f.config));
  fs.symlinkSync("/missing", pendingPushPath(f.config)); await expect(activateLinkedDeployment(f.client(), f.config)).rejects.toThrow("Pending push"); fs.rmSync(pendingPushPath(f.config));
  await withPushLock(f.config, async () => {await expect(activateLinkedDeployment(f.client(), f.config)).rejects.toThrow("still running");});
  expect(f.requests).toHaveLength(0);
});
it("refuses stale reports and older applied history even when activation succeeded", async () => {
  const f = await fixture(2); f.state!.activeInstanceId = randomUUID(); await activateLinkedDeployment(f.client(), f.config);
  f.state!.applied = {sequence: 1, revision: `sha256:${"a".repeat(64)}`, at: 1}; f.state!.lastReportSequence = 1; f.state!.stale = false;
  await expect(finishLinkedActivation(f.client(), f.config)).rejects.toThrow("not acknowledged");
  f.acknowledge(); f.state!.stale = true; await expect(finishLinkedActivation(f.client(), f.config)).rejects.toThrow("not acknowledged");
  f.acknowledge(); f.state!.lastReportSequence = 0; await expect(finishLinkedActivation(f.client(), f.config)).rejects.toThrow("not acknowledged");
  f.state = null; await expect(activateLinkedDeployment(f.client(), f.config, {resume: true})).rejects.toThrow("no longer current");
});
it("rejects malformed, foreign, permissive and nonregular private journals", async () => {
  const f = await fixture(); expect(await readPendingActivation(f.config)).toBeNull();
  await expect(finishLinkedActivation(f.client(), f.config)).rejects.toThrow("No issued"); await expect(cancelRejectedLinkedActivation(f.client(), f.config)).rejects.toThrow("Only a rejected");
  await activateLinkedDeployment(f.client(), f.config); const pending = (await readPendingActivation(f.config))!, file = pendingActivationPath(f.config);
  const malformed = [null, [], {}, {...pending, extra: true}, {...pending, schemaVersion: 2}, {...pending, config: "/foreign"}, {...pending, rejected: 0}, {...pending, link: {}}, {...pending, request: {}}, {...pending, request: {...pending.request, expectedConfigurationVersion: 4}}, {...pending, request: {...pending.request, expectedSequence: 2}}, {...pending, request: {...pending.request, revision: `sha256:${"a".repeat(64)}`}}, {...pending, receipt: {}}, {...pending, receipt: {...pending.receipt!, requestId: randomUUID()}}, {...pending, receipt: {...pending.receipt!, revision: `sha256:${"b".repeat(64)}`}}, {...pending, receipt: {...pending.receipt!, sequence: 2}}, {...pending, rejected: true}];
  for (const value of malformed) {fs.writeFileSync(file, JSON.stringify(value)); await expect(readPendingActivation(f.config)).rejects.toThrow("Invalid pending");}
  fs.writeFileSync(file, JSON.stringify(pending));
  vi.mocked(fs.openSync).mockImplementationOnce(() => {throw Object.assign(new Error("removed"), {code: "ENOENT"});});
  expect(await readPendingActivation(f.config)).toBeNull(); vi.mocked(fs.openSync).mockRestore();
  vi.mocked(fs.openSync).mockImplementationOnce(() => {throw Object.assign(new Error("denied"), {code: "EPERM"});});
  await expect(readPendingActivation(f.config)).rejects.toThrow("private regular"); vi.mocked(fs.openSync).mockRestore();
  vi.mocked(fs.fstatSync).mockReturnValueOnce({isFile: () => false, mode: 0o600, size: 0} as fs.Stats);
  await expect(readPendingActivation(f.config)).rejects.toThrow("private regular"); vi.mocked(fs.fstatSync).mockRestore();
  fs.writeFileSync(file, "invalid-json"); await expect(readPendingActivation(f.config)).rejects.toThrow("Invalid pending");
  fs.writeFileSync(file, " ".repeat(2_097_153)); await expect(readPendingActivation(f.config)).rejects.toThrow("private regular");
  fs.writeFileSync(file, JSON.stringify(pending)); fs.chmodSync(file, 0o644); await expect(readPendingActivation(f.config)).rejects.toThrow("private regular"); fs.rmSync(file);
  fs.mkdirSync(file, {mode: 0o700}); await expect(readPendingActivation(f.config)).rejects.toThrow("private regular"); fs.rmSync(file, {recursive: true});
  fs.symlinkSync(f.config, file); await expect(readPendingActivation(f.config)).rejects.toThrow("private regular"); expect(() => assertNoPendingPush(f.config)).toThrow("Pending activation");
});
it("never sends activation before durable intent and recovers failed receipt persistence", async () => {
  for (const failAt of [1, 2, 3, 4]) {
    const f = await fixture(); let count = 0;
    vi.mocked(fs.fsyncSync).mockImplementation(fd => {native.fsyncSync(fd); if (++count === failAt) throw new Error("disk failed");});
    await expect(activateLinkedDeployment(f.client(), f.config)).rejects.toThrow("disk failed");
    vi.mocked(fs.fsyncSync).mockRestore(); expect(f.requests).toHaveLength(failAt < 3 ? 0 : 1);
    const pending = await readPendingActivation(f.config);
    await activateLinkedDeployment(f.client(), f.config, pending ? {resume: true} : {});
    expect(f.requests).toHaveLength(1);
  }
});
it("refuses mismatched recovery receipts and propagates filesystem access errors safely", async () => {
  const f = await fixture(); const lossy = f.client(async (url, init) => {const response = await f.fetcher(url, init); if (init?.method === "POST") throw new TypeError("lost"); return response;});
  await expect(activateLinkedDeployment(lossy, f.config)).rejects.toThrow("lost");
  const wrongReceipt = f.client(async (url, init) => String(url).includes("/instances/") ? Response.json({...f.receipt!, configurationVersion: 4}) : f.fetcher(url, init));
  await expect(activateLinkedDeployment(wrongReceipt, f.config, {resume: true})).rejects.toThrow("does not match");
  expect((await readPendingActivation(f.config))!.receipt).toBeNull();
  vi.mocked(fs.lstatSync).mockImplementationOnce(() => {throw Object.assign(new Error("permission"), {code: "EPERM"});});
  expect(() => assertNoPendingPush(f.config)).toThrow("permission");
  vi.mocked(fs.lstatSync).mockRestore();
  expect(() => commitFileTransaction(pendingActivationPath(f.config), [])).toThrow("reserved");
});
it("supports the Windows directory-flush branch without weakening acknowledgement checks", async () => {
  const f = await fixture(); vi.stubGlobal("process", {...process, platform: "win32"});
  await activateLinkedDeployment(f.client(), f.config);
  fs.chmodSync(pendingActivationPath(f.config), 0o666); // Windows mode bits do not encode its ACL.
  f.acknowledge(); await finishLinkedActivation(f.client(), f.config);
  expect(await readPendingActivation(f.config)).toBeNull();
});
for (const boundary of [1, 2, 3, 4]) {
  it(`recovers an actual CLI-library process killed after fsync boundary ${boundary}`, async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    const server = createServer(async (request, response) => {
      try {
        let body = ""; for await (const part of request) body += part;
        const upstream = await f.fetcher(`http://${request.headers.host}${request.url}`, {method: request.method, ...(body ? {body} : {})});
        response.writeHead(upstream.status, {"content-type": "application/json"}); response.end(await upstream.text());
      } catch { response.writeHead(503); response.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as {port: number}).port;
    try {
      f = await fixture(1, `http://127.0.0.1:${port}`);
      const compiled = pathToFileURL(join(process.cwd(), "packages/cli/dist/main.js")).href;
      const core = pathToFileURL(join(process.cwd(), "packages/core/dist/index.js")).href;
      const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
        const {activateLinkedDeployment}=await import(${JSON.stringify(compiled)});
        const {LogturaServiceClient}=await import(${JSON.stringify(core)});
        const original=fs.fsyncSync;let count=0;
        fs.fsyncSync=(fd)=>{original(fd);if(++count===${boundary})process.kill(process.pid,'SIGKILL')};syncBuiltinESMExports();
        await activateLinkedDeployment(new LogturaServiceClient({url:${JSON.stringify(f.link.service)},token:'lt_cli_'+ 'T'.repeat(43),fetch}),${JSON.stringify(f.config)});`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {stdio: ["ignore", "ignore", "pipe"]});
      let stderr = ""; child.stderr.on("data", chunk => {stderr += chunk;});
      const result = await new Promise<string | null>((resolve, reject) => {
        const timeout = setTimeout(() => {child.kill("SIGKILL"); reject(new Error("Child persistence test timed out"));}, 10_000);
        child.on("error", error => {clearTimeout(timeout); reject(error);});
        child.on("close", (_code, signal) => {clearTimeout(timeout); resolve(signal);});
      });
      expect(result, stderr).toBe("SIGKILL");
      expect(f.requests).toHaveLength(boundary < 3 ? 0 : 1);
      const pending = await readPendingActivation(f.config);
      const receipt = await activateLinkedDeployment(f.client(), f.config, pending ? {resume: true} : {});
      expect(f.requests).toHaveLength(1);
      if (pending) expect(receipt.requestId).toBe(pending.request.requestId);
      f.acknowledge(); await finishLinkedActivation(f.client(), f.config);
      expect(await readPendingActivation(f.config)).toBeNull();
    } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
  }, 15_000);
}
it("requires explicit recovery for obsolete instances and safely releases journals after owned deletion", async () => {
  const f = await fixture(); await expect(abandonObsoleteLinkedActivation(f.client(), f.config)).rejects.toThrow("No pending");
  const offline = f.client(async (url, init) => init?.method === "POST" ? Promise.reject(new TypeError("offline")) : f.fetcher(url, init));
  await expect(activateLinkedDeployment(offline, f.config)).rejects.toThrow("offline");
  await expect(abandonObsoleteLinkedActivation(f.client(), f.config)).rejects.toThrow("uncertain");
  await activateLinkedDeployment(f.client(), f.config, {resume: true});
  await expect(abandonObsoleteLinkedActivation(f.client(), f.config)).rejects.toThrow("still current");
  const old = f.state; f.state = null; await expect(abandonObsoleteLinkedActivation(f.client(), f.config)).rejects.toThrow("still current"); f.state = old;
  f.state!.activeInstanceId = randomUUID(); await abandonObsoleteLinkedActivation(f.client(), f.config);
  expect(await readPendingActivation(f.config)).toBeNull(); expect(f.requests).toHaveLength(1);
  for (const changed of ["sequence", "revision"] as const) {
    const moved = await fixture(); await activateLinkedDeployment(moved.client(), moved.config);
    if (changed === "sequence") moved.state!.desired.sequence++;
    else { moved.state!.desired.document.discoverMonitors = true; moved.state!.desired.revision = await hashConfigDocument(moved.state!.desired.document); }
    await abandonObsoleteLinkedActivation(moved.client(), moved.config);
    expect(await readPendingActivation(moved.config)).toBeNull();
  }
  for (const status of [401, 404, 503]) {
    const deleted = await fixture(); await activateLinkedDeployment(deleted.client(), deleted.config);
    const client = deleted.client(async (url, init) => String(url).endsWith("/state") ? Response.json({error: status === 404 ? "not_found" : "unavailable"}, {status}) : deleted.fetcher(url, init));
    if (status === 404) { await abandonObsoleteLinkedActivation(client, deleted.config); expect(await readPendingActivation(deleted.config)).toBeNull(); }
    else { await expect(abandonObsoleteLinkedActivation(client, deleted.config)).rejects.toBeInstanceOf(ServiceError); expect(await readPendingActivation(deleted.config)).not.toBeNull(); }
  }
});
