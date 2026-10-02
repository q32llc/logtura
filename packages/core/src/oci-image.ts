import { immutableFlyImage } from "./fly";

const INDEX = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);
const MANIFEST = new Set(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"]);
const ACCEPT = [...INDEX, ...MANIFEST].join(",");
const digestPattern = /^sha256:[a-f0-9]{64}$/;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function token(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 65_536 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid registry token");
  return value;
}
async function bytes(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Invalid registry response");
  const parts: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > limit) throw new Error("Registry response exceeds size limit"); parts.push(next.value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.byteLength; } return result;
}
function json(value: Uint8Array): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)); if (!object(parsed)) throw new Error(); return parsed; }
  catch { throw new Error("Invalid registry JSON"); }
}
export interface ResolvedFlyImage { requestedImage: string; image: string; rootDigest: string; platformDigest: string; }
/** Verify registry bytes against an immutable root, selecting the unique
 * linux/amd64 manifest. Attestation/config digests are never runtime identities.
 * Caller-supplied credentials are scoped to this registry, never token realms. */
export async function resolveFlyImage(image: string, options: { fetch?: typeof fetch; token?: string; timeoutMs?: number } = {}): Promise<ResolvedFlyImage> {
  const requestedImage = immutableFlyImage(image), at = image.indexOf("@"), slash = image.indexOf("/");
  const registry = image.slice(0, slash), repository = image.slice(slash + 1, at), rootDigest = image.slice(at + 1);
  const origin = new URL(`https://${registry}`).origin, fetcher = options.fetch ?? fetch, timeout = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error("Invalid registry request timeout");
  const signal = AbortSignal.timeout(timeout); let authorization = options.token === undefined ? undefined : `Bearer ${token(options.token)}`;
  const request = (url: string, auth?: string) => fetcher(url, { redirect: "manual", credentials: "omit", signal, headers: { accept: ACCEPT, ...(auth === undefined ? {} : { authorization: auth }) } });
  async function manifest(digest: string, expectedSize?: number): Promise<Record<string, unknown>> {
    const url = `${origin}/v2/${repository}/manifests/${digest}`; let response = await request(url, authorization);
    if (response.status === 401 && authorization === undefined) {
      const challenge = response.headers.get("www-authenticate") ?? ""; await response.body?.cancel();
      if (!/^Bearer\s/i.test(challenge)) throw new Error("Registry requires explicit pull credentials");
      const realm = /\brealm="([^"]+)"/.exec(challenge)?.[1], service = /\bservice="([^"]+)"/.exec(challenge)?.[1];
      let endpoint: URL; try { endpoint = new URL(realm!); } catch { throw new Error("Invalid registry token realm"); }
      const docker = ["registry-1.docker.io", "docker.io", "index.docker.io"].includes(registry) && endpoint.origin === "https://auth.docker.io";
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || (endpoint.origin !== origin && !docker)) throw new Error("Untrusted registry token realm");
      endpoint.searchParams.set("scope", `repository:${repository}:pull`); if (service !== undefined) endpoint.searchParams.set("service", service);
      const grant = await request(endpoint.href); if (!grant.ok) { await grant.body?.cancel(); throw new Error(`Registry token request failed (HTTP ${grant.status})`); }
      const credentials = json(await bytes(grant, 65_536)); authorization = `Bearer ${token(credentials.token ?? credentials.access_token)}`;
      response = await request(url, authorization);
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Registry manifest request failed (HTTP ${response.status})`); }
    const declared = response.headers.get("docker-content-digest"), body = await bytes(response, 1_048_576);
    if (expectedSize !== undefined && body.byteLength !== expectedSize) throw new Error("Registry platform size mismatch");
    const actual = `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
    if (actual !== digest || (declared !== null && declared !== digest)) throw new Error("Registry manifest digest mismatch");
    const value = json(body); if (value.schemaVersion !== 2 || typeof value.mediaType !== "string") throw new Error("Invalid registry manifest"); return value;
  }
  function validate(value: Record<string, unknown>): void {
    if (!MANIFEST.has(value.mediaType as string) || !object(value.config) || typeof value.config.digest !== "string" || !digestPattern.test(value.config.digest) || !Array.isArray(value.layers)) throw new Error("Invalid registry image manifest");
  }
  const root = await manifest(rootDigest); let platformDigest = rootDigest;
  if (INDEX.has(root.mediaType as string)) {
    if (!Array.isArray(root.manifests) || root.manifests.length > 1000) throw new Error("Invalid registry image index");
    const selected = root.manifests.filter(value => object(value) && object(value.platform) && value.platform.os === "linux" && value.platform.architecture === "amd64" && (value.platform.variant === undefined || value.platform.variant === "v1"));
    if (selected.length !== 1) throw new Error("Registry index requires exactly one linux/amd64 image");
    const descriptor = selected[0] as Record<string, unknown>;
    if (typeof descriptor.digest !== "string" || !digestPattern.test(descriptor.digest) || !MANIFEST.has(descriptor.mediaType as string) || !Number.isSafeInteger(descriptor.size) || (descriptor.size as number) < 1 || (descriptor.size as number) > 1_048_576) throw new Error("Invalid registry platform descriptor");
    platformDigest = descriptor.digest; validate(await manifest(platformDigest, descriptor.size as number));
  } else validate(root);
  return { requestedImage, image: `${registry}/${repository}@${platformDigest}`, rootDigest, platformDigest };
}
