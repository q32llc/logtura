/**
 * Minimal port of fly-go's macaroon discharge flow for Cloudflare Workers.
 *
 * Fly's cli_session (a.k.a. `fly auth login`) returns a Macaroon (`fm2_…`)
 * that has third-party caveats. Without discharges, the Macaroon
 * resolves to "I know who you are" but no app/org/machine capabilities
 * — every REST + GraphQL call past `viewer` returns UNAUTHORIZED.
 *
 * flyctl handles this by walking the Macaroon's caveats, finding any
 * Caveat3P entries, POSTing the encrypted ticket to the third-party
 * service's `/.well-known/macfly/3p` endpoint, and concatenating the
 * returned discharge tokens with the original token in a comma-joined
 * `FlyV1` Authorization header.
 *
 * We only need the **client** half of that — decode + extract tickets
 * + fetch discharges. We never issue or verify Macaroons ourselves.
 *
 * Wire format references:
 *   - https://github.com/superfly/macaroon (Go reference impl)
 *   - https://github.com/superfly/macaroon/blob/main/tp/README.md
 *
 * Encoding details:
 *   - `fm2_<base64>` where base64 is std padded base64 of the raw
 *     msgpack bytes.
 *   - Macaroon struct = msgpack array `[Nonce, Location, CaveatSet, Tail]`
 *     because Go's encoder uses `UseArrayEncodedStructs(true)`.
 *   - Nonce = `[KID, Rnd]` (v0) or `[KID, Rnd, Proof]` (v1).
 *   - CaveatSet has a custom encoder: flat array of length `2N`
 *     interleaving `[type_uint, body, type_uint, body, …]`.
 *   - Caveat3P body = `[Location, VerifierKey, Ticket]`.
 *   - We only care about the Cav3P type id.
 */

import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";

/** Caveat type ids — match the iota in superfly/macaroon/caveat.go. */
const CAV_FLYIO_ORGANIZATION = 0;
const CAV_3P = 11;
/** resset.Action bitmap values from superfly/macaroon/resset/action.go.
 *  Action is a uint16; read is 1 << 0. */
const ACTION_READ = 1;
/** Fly's well-known "permission" location — what permission macaroons
 *  carry vs the discharge macaroons at /aaa/v1 etc. Used to identify
 *  the macaroon to attenuate inside a bundle. */
const LOCATION_PERMISSION = "https://api.fly.io/v1";

const TOKEN_PREFIX_V2 = "fm2";
const TOKEN_PREFIX_PERMISSION = "fm1r";
const TOKEN_PREFIX_DISCHARGE = "fm1a";
const TOKEN_PREFIX_OAUTH = "fo1";

const INIT_PATH = "/.well-known/macfly/3p";

export class MacaroonError extends Error {}

/** Strip "FlyV1 "/"Bearer " from a header value if present. */
export function stripScheme(header: string): string {
  const trimmed = header.trim();
  const space = trimmed.indexOf(" ");
  if (space < 0) return trimmed;
  const scheme = trimmed.slice(0, space).toLowerCase();
  if (scheme === "flyv1" || scheme === "bearer") {
    return stripScheme(trimmed.slice(space + 1));
  }
  return trimmed;
}

/** A token segment from a FlyV1 Authorization header. Macaroon
 *  segments expose their decoded bytes; OAuth segments and any other
 *  pass-through-only segments keep just their original wire form. */
export type FlyTokenSegment =
  | { kind: "macaroon"; prefix: "fm2" | "fm1r" | "fm1a"; raw: Uint8Array }
  | { kind: "passthrough"; original: string };

/** Parse a comma-joined FlyV1 token header into ordered segments. */
export function parseFlyTokenSegments(header: string): FlyTokenSegment[] {
  const stripped = stripScheme(header);
  const tokens = stripped.split(",").map((t) => t.trim()).filter(Boolean);
  const out: FlyTokenSegment[] = [];
  for (const tok of tokens) {
    const sep = tok.indexOf("_");
    if (sep < 0) {
      throw new MacaroonError(`malformed token: missing prefix separator`);
    }
    const prefix = tok.slice(0, sep);
    const b64 = tok.slice(sep + 1);
    if (prefix === TOKEN_PREFIX_OAUTH) {
      out.push({ kind: "passthrough", original: tok });
      continue;
    }
    if (
      prefix === TOKEN_PREFIX_V2 ||
      prefix === TOKEN_PREFIX_PERMISSION ||
      prefix === TOKEN_PREFIX_DISCHARGE
    ) {
      out.push({
        kind: "macaroon",
        prefix: prefix as "fm2" | "fm1r" | "fm1a",
        raw: b64ToBytes(b64),
      });
      continue;
    }
    throw new MacaroonError(`unknown token prefix: ${prefix}`);
  }
  if (out.length === 0) {
    throw new MacaroonError("no tokens in header");
  }
  return out;
}

/** Convenience: just the raw macaroon bytes from each segment, in
 *  order. Useful when you don't care about OAuth pass-throughs. */
export function parseFlyTokens(header: string): Uint8Array[] {
  return parseFlyTokenSegments(header)
    .filter((s): s is Extract<FlyTokenSegment, { kind: "macaroon" }> => s.kind === "macaroon")
    .map((s) => s.raw);
}

/** Re-encode segments back to the comma-joined wire form (no scheme
 *  prefix). Macaroons re-emit with their original prefix; OAuth
 *  pass-throughs use their stored original string verbatim. */
export function encodeFlyTokenSegments(segments: FlyTokenSegment[]): string {
  return segments
    .map((s) =>
      s.kind === "macaroon"
        ? `${s.prefix}_${bytesToB64(s.raw)}`
        : s.original,
    )
    .join(",");
}

/** Re-encode raw macaroon byte slices as `fm2_…,fm2_…`. Drops any
 *  prefix-info — only safe for caller-controlled bundles, not for
 *  preserving an existing one (use {@link encodeFlyTokenSegments}). */
export function encodeFlyTokens(macaroons: Uint8Array[]): string {
  return macaroons
    .map((m) => `${TOKEN_PREFIX_V2}_${bytesToB64(m)}`)
    .join(",");
}

export interface ThirdPartyCaveat {
  location: string;
  /** Encrypted ticket bytes, opaque to us. We base64 them and POST
   *  to the 3p service. */
  ticket: Uint8Array;
}

export interface DecodedMacaroon {
  location: string;
  /** Nonce KID, used by discharges to refer back to their parent
   *  caveat (a discharge's KID equals the parent caveat's ticket). */
  nonceKid: Uint8Array;
  thirdPartyCaveats: ThirdPartyCaveat[];
}

/** Decode the relevant fields of a raw macaroon. We don't validate
 *  signatures — that's the issuing server's job. */
export function decodeMacaroon(raw: Uint8Array): DecodedMacaroon {
  const decoded = msgpackDecode(raw);
  if (!Array.isArray(decoded) || decoded.length < 4) {
    throw new MacaroonError("macaroon: not a 4-element array");
  }
  const [nonceArr, location, caveatSetArr /*, tail*/] = decoded;
  if (!Array.isArray(nonceArr) || nonceArr.length < 2) {
    throw new MacaroonError("macaroon: nonce is not a 2/3-element array");
  }
  const kid = toBytes(nonceArr[0]);
  if (typeof location !== "string") {
    throw new MacaroonError("macaroon: location is not a string");
  }
  if (!Array.isArray(caveatSetArr) || caveatSetArr.length % 2 !== 0) {
    throw new MacaroonError("macaroon: caveat set has odd length");
  }
  const thirdPartyCaveats: ThirdPartyCaveat[] = [];
  for (let i = 0; i < caveatSetArr.length; i += 2) {
    const type = Number(caveatSetArr[i]);
    const body = caveatSetArr[i + 1];
    if (type !== CAV_3P) continue;
    if (!Array.isArray(body) || body.length < 3) {
      throw new MacaroonError("macaroon: Caveat3P body is not a 3-element array");
    }
    const tpLoc = body[0];
    const ticket = body[2];
    if (typeof tpLoc !== "string") {
      throw new MacaroonError("macaroon: 3p location is not a string");
    }
    thirdPartyCaveats.push({ location: tpLoc, ticket: toBytes(ticket) });
  }
  return { location, nonceKid: kid, thirdPartyCaveats };
}

interface DischargeInitResponse {
  discharge?: string;
  poll_url?: string;
  user_interactive?: { user_url?: string; poll_url?: string };
  error?: string;
}

interface DischargePollResponse {
  discharge?: string;
  error?: string;
}

/**
 * Take a `FlyV1 fm2_…,fm2_…` header (or comma-joined token list with
 * scheme stripped), walk every macaroon in the bundle, fetch any
 * discharge tokens missing for third-party caveats, and return a new
 * `FlyV1` Authorization header value that includes the originals
 * plus the new discharges.
 *
 * Existing discharges matched by Nonce.KID to a third-party ticket are
 * replaced with fresh discharges; permission and OAuth tokens are preserved.
 *
 * We DON'T do user-interactive flows — for the cli_session token, the
 * user-interaction was already done at the approval URL.
 */
export async function dischargeBundle(
  authHeader: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);

  const segments = parseFlyTokenSegments(authHeader);
  const macaroonSegments = segments.filter(
    (s): s is Extract<FlyTokenSegment, { kind: "macaroon" }> => s.kind === "macaroon",
  );
  const decoded = macaroonSegments.map((s) => decodeMacaroon(s.raw));

  // Identify which macaroons are existing discharges: a macaroon is a
  // discharge when its Nonce.KID equals some other macaroon's
  // Caveat3P.ticket. Strip them — Fly's discharges from cli_session
  // approval time go stale and the API rejects them silently. We
  // always fetch fresh ones below. (flyctl handles this via
  // ValidityWindow-based pruning; we'll add that as an optimization
  // when we want to avoid the extra round-trip.)
  const tickets = new Set<string>();
  for (const m of decoded) {
    for (const cav of m.thirdPartyCaveats) tickets.add(toHex(cav.ticket));
  }
  const keepMacaroon: boolean[] = decoded.map((m) => !tickets.has(toHex(m.nonceKid)));

  const keptMacaroonDecoded = decoded.filter((_, i) => keepMacaroon[i]);

  const newDischarges: Uint8Array[] = [];
  for (const m of keptMacaroonDecoded) {
    for (const cav of m.thirdPartyCaveats) {
      const raw = await fetchOneDischarge(cav, authHeader, fetchImpl, deadline);
      newDischarges.push(raw);
    }
  }

  // Reassemble: all kept macaroons (in original order, keeping their
  // original prefixes), then fresh discharges, then any pass-through
  // segments (OAuth tokens) preserved at the end so the GraphQL
  // header still has them.
  const passthroughs = segments.filter(
    (s): s is Extract<FlyTokenSegment, { kind: "passthrough" }> => s.kind === "passthrough",
  );
  const keptMacaroonSegments = macaroonSegments.filter((_, i) => keepMacaroon[i]);
  const newSegments: FlyTokenSegment[] = [
    ...keptMacaroonSegments,
    ...newDischarges.map(
      (raw): FlyTokenSegment => ({ kind: "macaroon", prefix: "fm2", raw }),
    ),
    ...passthroughs,
  ];
  return `FlyV1 ${encodeFlyTokenSegments(newSegments)}`;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

async function fetchOneDischarge(
  caveat: ThirdPartyCaveat,
  authHeader: string,
  fetchImpl: typeof fetch,
  deadline: number,
): Promise<Uint8Array> {
  const initUrl = caveat.location.endsWith("/")
    ? caveat.location + INIT_PATH.slice(1)
    : caveat.location + INIT_PATH;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  headers.authorization = authHeader;

  const initRes = await fetchImpl(initUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ ticket: bytesToB64(caveat.ticket) }),
  });
  const initBody = await readDischargeResponse(initRes, "init") as DischargeInitResponse;

  if (initBody.discharge) {
    return decodeDischargeString(initBody.discharge);
  }

  // Poll path. The 3p service is doing async approval; flyctl's
  // user-interactive flow lives here. cli_session approval already
  // happened at auth_url, so the 3p should respond ready promptly.
  const pollPath = initBody.poll_url ?? initBody.user_interactive?.poll_url;
  if (!pollPath) {
    throw new MacaroonError(
      "discharge init: missing discharge or poll_url",
    );
  }
  const pollUrl = absolutizePollUrl(caveat.location, pollPath);

  let backoff = 500;
  while (Date.now() < deadline) {
    const pollRes = await fetchImpl(pollUrl, {
      method: "GET",
      headers: { accept: "application/json", authorization: authHeader },
    });
    if (pollRes.status === 202) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 4_000);
      continue;
    }
    const pollBody = await readDischargeResponse(pollRes, "poll") as DischargePollResponse;

    if (pollBody.discharge) {
      return decodeDischargeString(pollBody.discharge);
    }
    throw new MacaroonError(
      "discharge poll: missing discharge",
    );
  }
  throw new MacaroonError(
    "discharge timed out",
  );
}

/** Provider error bodies can contain tokens. Reject invalid envelopes with
 * static errors before inspecting optional discharge or polling fields. */
async function readDischargeResponse(response: Response, phase: "init" | "poll"): Promise<DischargeInitResponse> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new MacaroonError(`discharge ${phase}: HTTP ${response.status}`);
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new MacaroonError(`discharge ${phase}: non-JSON response`); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MacaroonError(`discharge ${phase}: invalid response`);
  }
  const value = body as DischargeInitResponse;
  if (value.error) throw new MacaroonError(`discharge ${phase}: provider error`);
  for (const field of [value.discharge, value.poll_url]) {
    if (field !== undefined && typeof field !== "string") throw new MacaroonError(`discharge ${phase}: invalid response`);
  }
  if (value.user_interactive !== undefined) {
    if (!value.user_interactive || typeof value.user_interactive !== "object" || Array.isArray(value.user_interactive)) throw new MacaroonError(`discharge ${phase}: invalid response`);
    if (value.user_interactive.poll_url !== undefined && typeof value.user_interactive.poll_url !== "string") throw new MacaroonError(`discharge ${phase}: invalid response`);
  }
  return value;
}

function absolutizePollUrl(tpLocation: string, pollPath: string): string {
  // poll_url may be absolute or path-relative to the 3p location.
  if (/^https?:\/\//i.test(pollPath)) return pollPath;
  if (pollPath.startsWith("/")) {
    const u = new URL(tpLocation);
    return `${u.origin}${pollPath}`;
  }
  // Relative without leading slash — append to location.
  if (tpLocation.endsWith("/")) return tpLocation + pollPath;
  return `${tpLocation}/${pollPath}`;
}

/** Decode a base64-encoded discharge token (which may or may not have
 *  the `fm2_` prefix — Fly's response sometimes returns just the
 *  base64 of the raw macaroon, sometimes the full prefixed form). */
function decodeDischargeString(s: string): Uint8Array {
  const sep = s.indexOf("_");
  if (sep > 0) {
    const prefix = s.slice(0, sep);
    if (
      prefix === TOKEN_PREFIX_V2 ||
      prefix === TOKEN_PREFIX_PERMISSION ||
      prefix === TOKEN_PREFIX_DISCHARGE
    ) {
      return b64ToBytes(s.slice(sep + 1));
    }
  }
  return b64ToBytes(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- byte helpers (Workers-compatible) -------------------------------

function b64ToBytes(b64: string): Uint8Array {
  let bin: string;
  try { bin = atob(b64); } catch { throw new MacaroonError("invalid token encoding"); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v) && v.every((n) => typeof n === "number")) {
    return new Uint8Array(v as number[]);
  }
  throw new MacaroonError("expected bytes");
}

// --- attenuation ------------------------------------------------------
//
// Macaroon attenuation: anyone holding a macaroon can add restrictive
// caveats by appending [type, body] to the caveat-set and recomputing
// the tail HMAC. No issuer key required — that's the whole point of
// macaroons.
//
// The HMAC chain (from superfly/macaroon/macaroon.go Macaroon.Add):
//
//   for each caveat c:
//     opc = msgpack(CaveatSet{ caveats: [c] })   // a 2-element array [type, body]
//     tail = HMAC-SHA256(tail, opc)
//
// So one caveat's contribution is the msgpack-encoding of a one-element
// CaveatSet, not the body alone. The CaveatSet's custom encoder writes
// `array of length 2N = [type_0, body_0, type_1, body_1, …]`, so for a
// single caveat it's literally `[type, body]`.

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  // SubtleCrypto wants BufferSource (ArrayBuffer-backed). Workers'
  // type defs widen Uint8Array's buffer to ArrayBufferLike, which
  // doesn't fit. `.slice()` returns a fresh ArrayBuffer-backed view.
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.slice().buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data.slice().buffer);
  return new Uint8Array(sig);
}

/** Extract an Organization caveat's org id from a decoded caveat-set
 *  array. Returns null when none is present (e.g., trying to
 *  attenuate a macaroon that isn't org-scoped, which would be a
 *  programmer error here). */
function findOrgIdInCaveatSet(caveatSet: unknown[]): bigint | number | null {
  for (let i = 0; i < caveatSet.length; i += 2) {
    const type = Number(caveatSet[i]);
    const body = caveatSet[i + 1];
    if (type !== CAV_FLYIO_ORGANIZATION) continue;
    if (!Array.isArray(body) || body.length < 2) continue;
    const id = body[0];
    if (typeof id === "bigint" || typeof id === "number") return id;
  }
  return null;
}

/**
 * Attenuate a single permission macaroon to read-only access on its
 * existing org. Mirrors flyctl's runOrgRead in
 * superfly/flyctl/internal/command/tokens/create.go: find the
 * existing Organization caveat to recover the org id, then append a
 * fresh `Organization{ID, Mask: ActionRead}` caveat and recompute the
 * tail HMAC. The returned bytes are the new raw macaroon.
 */
export async function attenuateOrgReadOnly(
  rawMacaroon: Uint8Array,
): Promise<Uint8Array> {
  const decoded = msgpackDecode(rawMacaroon);
  if (!Array.isArray(decoded) || decoded.length < 4) {
    throw new MacaroonError("attenuate: macaroon is not a 4-element array");
  }
  const [nonceArr, location, caveatSetArr, tailRaw] = decoded;
  if (!Array.isArray(caveatSetArr) || caveatSetArr.length % 2 !== 0) {
    throw new MacaroonError("attenuate: caveat set has odd length");
  }
  const tailBytes = toBytes(tailRaw);
  const orgId = findOrgIdInCaveatSet(caveatSetArr);
  if (orgId === null) {
    throw new MacaroonError(
      "attenuate: macaroon has no Organization caveat to bind read-only to",
    );
  }
  // Build the new caveat body. UseArrayEncodedStructs(true) on the
  // Go side means Organization{ID, Mask} serializes as a 2-element
  // array — matches what we emit here.
  const newCaveatBody = [orgId, ACTION_READ];
  // CaveatSet's custom encoder writes a flat 2N-length array. For
  // one caveat that's literally `[type, body]`. useBigInt64 lets us
  // round-trip a uint64 org id through BigInt if the decoder gave
  // us one (Fly's IDs are small enough to fit Number today, but the
  // round-trip is safer than narrowing).
  const opc = msgpackEncode([CAV_FLYIO_ORGANIZATION, newCaveatBody], {
    useBigInt64: true,
  });
  const newTail = await hmacSha256(tailBytes, opc);
  const updatedCaveatSet = [
    ...caveatSetArr,
    CAV_FLYIO_ORGANIZATION,
    newCaveatBody,
  ];
  const newMacaroon = [nonceArr, location, updatedCaveatSet, newTail];
  return msgpackEncode(newMacaroon, { useBigInt64: true });
}

/**
 * Attenuate every permission macaroon in a FlyV1 bundle to read-only
 * (discharge macaroons pass through verbatim). Permission macaroons
 * are identified by location == https://api.fly.io/v1, matching
 * flyio.LocationPermission in superfly/macaroon/flyio.
 */
export async function attenuateBundleOrgReadOnly(
  authHeader: string,
): Promise<string> {
  const segments = parseFlyTokenSegments(authHeader);
  const out: FlyTokenSegment[] = [];
  for (const seg of segments) {
    if (seg.kind !== "macaroon") {
      out.push(seg);
      continue;
    }
    const decoded = msgpackDecode(seg.raw);
    const loc =
      Array.isArray(decoded) && typeof decoded[1] === "string"
        ? decoded[1]
        : "";
    if (loc !== LOCATION_PERMISSION) {
      // Discharge or unrelated; leave alone.
      out.push(seg);
      continue;
    }
    const attenuated = await attenuateOrgReadOnly(seg.raw);
    out.push({ kind: "macaroon", prefix: seg.prefix, raw: attenuated });
  }
  return encodeFlyTokenSegments(out);
}
