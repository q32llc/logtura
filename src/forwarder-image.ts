/**
 * Resolve `ghcr.io/q32llc/logtura-forwarder:<tag>` to a concrete
 * sha256 digest at deploy time.
 *
 * Why: Fly's `--image :latest` doesn't re-resolve once a machine
 * has a digest cached. Pinning by digest gives every deploy an
 * immutable image identity — a redeploy with the same Dockerfile
 * stays on the same digest; a forwarder rebuild rolls forward
 * deterministically.
 *
 * OCI Distribution spec flow:
 *   1) GET .../token?...&scope=repository:<repo>:pull → bearer
 *   2) HEAD .../v2/<repo>/manifests/<tag> with that bearer +
 *      Accept: vnd.oci.image.index.v1+json + manifest.v2+json
 *   3) Read Docker-Content-Digest header
 */

import { resolveFlyImage } from "@logtura/core";
const REPO = "q32llc/logtura-forwarder";
const FORWARDER_REGISTRY = "ghcr.io";

const ACCEPT_HEADER = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(",");

interface TokenResponse {
  token?: string;
  access_token?: string;
}

async function fetchAnonymousToken(): Promise<string> {
  const url = `https://${FORWARDER_REGISTRY}/token?service=${FORWARDER_REGISTRY}&scope=repository:${REPO}:pull`;
  const res = await fetch(url, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(
      `forwarder token request failed: HTTP ${res.status}`,
    );
  }
  let body: TokenResponse;
  try { body = (await res.json()) as TokenResponse; } catch { throw new Error("Invalid forwarder token response"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid forwarder token response");
  const tok = body.token ?? body.access_token;
  if (typeof tok !== "string" || !tok) throw new Error("forwarder token response missing `token` field");
  return tok;
}

/** Resolves a forwarder tag (e.g. "latest", "sha-abc1234") to its
 *  concrete digest `sha256:...`. Returns the digest only — the
 *  caller builds the full `<registry>/<repo>@<digest>` reference. */
export async function resolveForwarderDigest(tag = "latest"): Promise<string> {
  const token = await fetchAnonymousToken();
  const res = await fetch(
    `https://${FORWARDER_REGISTRY}/v2/${REPO}/manifests/${encodeURIComponent(tag)}`,
    {
      method: "HEAD",
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(20_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: ACCEPT_HEADER,
      },
    },
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(
      `forwarder manifest HEAD failed: HTTP ${res.status}`,
    );
  }
  const digest = res.headers.get("docker-content-digest");
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(
      `forwarder manifest missing docker-content-digest header (got ${digest})`,
    );
  }
  return (await resolveFlyImage(forwarderImageRef(digest), { token })).platformDigest;
}

/** Full image reference for the Fly Machines API:
 *  `ghcr.io/q32llc/logtura-forwarder@sha256:...`. */
export function forwarderImageRef(digest: string): string {
  return `${FORWARDER_REGISTRY}/${REPO}@${digest}`;
}
