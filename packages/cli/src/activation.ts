import {
  canonicalConfigJson, hashConfigDocument, ServiceError,
  validateDeploymentActivation, validateDeploymentInstanceReceipt,
  type DeploymentInstanceActivation, type DeploymentInstanceReceipt,
  type LogturaServiceClient,
} from "@logtura/core";
import {
  constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync,
  fsyncSync, linkSync, renameSync, rmSync, lstatSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readDeploymentLink, validateDeploymentLink, privateFingerprint, type DeploymentLink } from "./deployment-link";
import { readConfigDoc, readConfigEnvironment } from "./config";
import { assertNoPendingPush, assertTransactionClear, pendingPushPath, pendingActivationPath } from "./file-transaction";
import { withPushLock } from "./push-lock";

/** No resolved payloads or account/reporting tokens enter this private journal. */
export interface PendingActivation {
  schemaVersion: 1;
  config: string;
  link: DeploymentLink;
  request: DeploymentInstanceActivation;
  receipt: DeploymentInstanceReceipt | null;
  rejected: boolean;
}
function invalid(): never { throw new Error("Invalid pending activation; retain it for recovery"); }
function matches(receipt: DeploymentInstanceReceipt, request: DeploymentInstanceActivation): boolean {
  return receipt.requestId === request.requestId && receipt.configurationVersion === request.expectedConfigurationVersion &&
    receipt.sequence === request.expectedSequence && receipt.revision === request.revision;
}
export async function readPendingActivation(config: string): Promise<PendingActivation | null> {
  const path = pendingActivationPath(config);
  // Windows lacks O_NOFOLLOW; reject nonregular paths before opening on every OS.
  try { if (!lstatSync(path).isFile()) throw new Error("nonregular"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Pending activation must be a private regular file"); }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Pending activation must be a private regular file"); }
  let value: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2_097_152 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Pending activation must be a private regular file");
    try { value = JSON.parse(readFileSync(fd, "utf8")); } catch { invalid(); }
  } finally { closeSync(fd); }
  const pending = value as PendingActivation;
  if (!pending || typeof pending !== "object" || Array.isArray(pending) ||
    Object.keys(pending).length !== 6 || Object.keys(pending).some(key => !["schemaVersion", "config", "link", "request", "receipt", "rejected"].includes(key)) ||
    pending.schemaVersion !== 1 || pending.config !== resolve(config) || typeof pending.rejected !== "boolean") invalid();
  try {
    pending.link = await validateDeploymentLink(pending.link);
    pending.request = validateDeploymentActivation(pending.request);
    if (pending.request.expectedConfigurationVersion !== pending.link.configurationVersion || pending.request.expectedSequence !== pending.link.desiredSequence || pending.request.revision !== pending.link.revision) invalid();
    if (pending.receipt !== null) {
      pending.receipt = validateDeploymentInstanceReceipt(pending.receipt);
      if (!matches(pending.receipt, pending.request) || pending.rejected) invalid();
    }
  } catch { invalid(); }
  return pending;
}
function flush(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function flushParent(path: string): void { if (process.platform !== "win32") flush(dirname(path)); }
function save(config: string, pending: PendingActivation, initial = false): void {
  const path = pendingActivationPath(config), stage = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(stage, JSON.stringify(pending) + "\n", { flag: "wx", mode: 0o600 });
    flush(stage);
    if (initial) linkSync(stage, path); else renameSync(stage, path);
  } finally { rmSync(stage, { force: true }); }
  flushParent(path);
}
function clear(config: string): void { const path = pendingActivationPath(config); rmSync(path); flushParent(path); }
async function authenticate(client: LogturaServiceClient, link: DeploymentLink): Promise<void> {
  if (client.url !== link.service) throw new Error("Activation service does not match the linked origin");
  if ((await client.whoami()).id !== link.accountId) throw new Error("Activation account does not match the linked account");
}
async function unchanged(config: string, link: DeploymentLink): Promise<void> {
  const current = await readDeploymentLink(config);
  if (canonicalConfigJson(current) !== canonicalConfigJson(link) || await hashConfigDocument(readConfigDoc(config)) !== link.revision) throw new Error("Local configuration changed; retain pending activation for recovery");
  const env = readConfigEnvironment(config);
  if (Object.entries(link.fingerprints).some(([name, proof]) => env[name] === undefined || privateFingerprint(link.privateKey, name, env[name]!) !== proof)) throw new Error("Private payload changed; retain pending activation for recovery");
}
async function currentInstance(client: LogturaServiceClient, pending: PendingActivation) {
  const state = await client.getDeploymentConfigurationState(pending.link.deployment.id);
  if (!state || state.activeInstanceId !== pending.receipt!.instanceId || state.desired.sequence !== pending.request.expectedSequence || state.desired.revision !== pending.request.revision) throw new Error("Issued instance or revision is no longer current; retain activation for recovery");
  return state;
}
/** Issue once, recovering acknowledgement loss through the immutable server receipt.
 * The caller installs this receipt's runtime. Success here does not imply apply. */
export async function activateLinkedDeployment(client: LogturaServiceClient, config: string, options: {resume?: boolean} = {}): Promise<DeploymentInstanceReceipt> {
  return withPushLock(config, async () => {
    assertTransactionClear(config);
    let pending = await readPendingActivation(config);
    if (!!pending !== (options.resume === true)) throw new Error(pending ? "Pending activation; resume it before issuing another instance" : "No pending activation to resume");
    const link = pending?.link ?? await readDeploymentLink(config);
    if (!link) throw new Error("Pull a hosted deployment before activating");
    await authenticate(client, link);
    await unchanged(config, link);
    // Push and activation share a lock and cannot own the same configuration.
    let pushFd: number;
    try { pushFd = openSync(pendingPushPath(config), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Pending push; recover it before activation"); pushFd = -1; }
    if (pushFd !== -1) { closeSync(pushFd); throw new Error("Pending push; recover it before activation"); }
    if (!pending) {
      assertNoPendingPush(config);
      const state = await client.getDeploymentConfigurationState(link.deployment.id);
      if (!state || state.desired.sequence !== link.desiredSequence || state.desired.revision !== link.revision || state.desired.configurationVersion !== link.configurationVersion) throw new Error("Remote configuration changed; pull before activating");
      pending = {schemaVersion: 1, config: resolve(config), link, request: validateDeploymentActivation({requestId: randomUUID(), expectedConfigurationVersion: link.configurationVersion, expectedSequence: link.desiredSequence, revision: link.revision, expectedInstanceId: state.activeInstanceId}), receipt: null, rejected: false};
      await unchanged(config, link);
      save(config, pending, true);
    }
    if (!pending.receipt) {
      const recovered = await client.getDeploymentInstanceReceipt(link.deployment.id, pending.request.requestId);
      if (recovered) {
        if (!matches(recovered, pending.request)) throw new Error("Activation receipt does not match the pending request");
        pending = {...pending, receipt: recovered, rejected: false}; save(config, pending);
      } else {
        if (pending.rejected) throw new Error("Activation rejected; cancel the rejected request before starting again");
        await unchanged(config, link);
        let receipt: DeploymentInstanceReceipt;
        try { receipt = await client.activateDeploymentInstance(link.deployment.id, pending.request); }
        catch (error) { if (error instanceof ServiceError && [400, 409].includes(error.status)) { pending.rejected = true; save(config, pending); } throw error; }
        pending = {...pending, receipt}; save(config, pending);
      }
    }
    await unchanged(config, link);
    await currentInstance(client, pending);
    return structuredClone(pending.receipt!);
  });
}
/** Only a still-current, accepted runtime report permits completion/removing intent. */
export async function finishLinkedActivation(client: LogturaServiceClient, config: string): Promise<void> {
  return withPushLock(config, async () => {
    assertTransactionClear(config);
    const pending = await readPendingActivation(config);
    if (!pending?.receipt) throw new Error("No issued activation to finish");
    await authenticate(client, pending.link); await unchanged(config, pending.link);
    const state = await currentInstance(client, pending);
    if (!state || state.activeInstanceId !== pending.receipt.instanceId || state.stale || state.lastReportSequence <= 0 || state.desired.sequence !== pending.receipt.sequence || state.applied?.sequence !== pending.receipt.sequence || state.applied.revision !== pending.receipt.revision) throw new Error("Issued runtime has not acknowledged its current revision");
    await unchanged(config, pending.link);
    clear(config);
  });
}
/** A definitive rejected request with no server receipt can be abandoned safely.
 * Unknown outcomes and issued (even retired) instances retain their journal. */
export async function cancelRejectedLinkedActivation(client: LogturaServiceClient, config: string): Promise<void> {
  return withPushLock(config, async () => {
    assertTransactionClear(config);
    const pending = await readPendingActivation(config);
    if (!pending || !pending.rejected || pending.receipt) throw new Error("Only a rejected, unissued activation may be cancelled");
    await authenticate(client, pending.link);
    if (await client.getDeploymentInstanceReceipt(pending.link.deployment.id, pending.request.requestId)) throw new Error("Server has an activation receipt; resume before recovery");
    clear(config);
  });
}
/** Explicit local recovery for an issued instance made obsolete remotely.
 * This neither stops a remote runtime nor changes the service's active instance. */
export async function abandonObsoleteLinkedActivation(client: LogturaServiceClient, config: string): Promise<void> {
  return withPushLock(config, async () => {
    assertTransactionClear(config);
    const pending = await readPendingActivation(config);
    if (!pending) throw new Error("No pending activation to abandon");
    await authenticate(client, pending.link);
    let state;
    try { state = await client.getDeploymentConfigurationState(pending.link.deployment.id); }
    catch (error) {
      if (error instanceof ServiceError && error.status === 404 && error.code === "not_found") { clear(config); return; }
      throw error;
    }
    if (!pending.receipt) throw new Error("Activation outcome is uncertain; resume before abandoning");
    if (!state || (state.activeInstanceId === pending.receipt.instanceId && state.desired.sequence === pending.receipt.sequence && state.desired.revision === pending.receipt.revision)) throw new Error("Issued activation is still current; resume before recovery");
    clear(config);
  });
}
