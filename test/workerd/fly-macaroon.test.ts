import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import {mockFetch} from "./_setup";
import {
  attenuateBundleOrgReadOnly,
  attenuateOrgReadOnly,
  decodeMacaroon,
  encodeFlyTokens,
  parseFlyTokens,
  parseFlyTokenSegments,
  stripScheme,
  dischargeBundle,
  encodeFlyTokenSegments,
  MacaroonError,
} from "../../src/deploy-targets/fly-macaroon";

/** Build a synthetic permission macaroon with one Organization caveat
 *  at the given mask. The tail is fixed bytes — attenuation chains
 *  HMAC forward from whatever tail it sees, so the chain root doesn't
 *  need to be cryptographically valid for these tests. We're testing
 *  our re-encoding + HMAC stepping, not Fly's signing key. */
function makePermMacaroon(orgId: number, mask: number, tail: Uint8Array): Uint8Array {
  const nonce = [new Uint8Array([1, 2, 3]), new Uint8Array([9, 9, 9])];
  const caveats = [0, [orgId, mask]];
  return msgpackEncode([nonce, "https://api.fly.io/v1", caveats, tail], {
    useBigInt64: true,
  });
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const ck = await crypto.subtle.importKey(
    "raw",
    key.slice().buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", ck, data.slice().buffer));
}

describe("stripScheme", () => {
  it("strips FlyV1 / Bearer prefixes case-insensitively", () => {
    expect(stripScheme("FlyV1 fm2_abc")).toBe("fm2_abc");
    expect(stripScheme("bearer fm2_abc")).toBe("fm2_abc");
    expect(stripScheme("fm2_abc")).toBe("fm2_abc");
  });
});

describe("parseFlyTokenSegments", () => {
  it("parses macaroon segments and rejects malformed tokens", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const header = `FlyV1 fm2_${bytesToB64(raw)},fm1a_${bytesToB64(raw)}`;
    const segs = parseFlyTokenSegments(header);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ kind: "macaroon", prefix: "fm2" });
    expect(segs[1]).toMatchObject({ kind: "macaroon", prefix: "fm1a" });
    expect(() => parseFlyTokenSegments("malformed")).toThrow();
  });
});

describe("attenuateOrgReadOnly", () => {
  it("appends an Organization{Mask: ActionRead} caveat and recomputes the tail", async () => {
    const origTail = new Uint8Array(32).fill(0xab);
    const raw = makePermMacaroon(12345, 31 /* full RWXCD */, origTail);
    const out = await attenuateOrgReadOnly(raw);

    const decoded = msgpackDecode(out) as unknown[];
    expect(decoded[1]).toBe("https://api.fly.io/v1");
    const caveats = decoded[2] as unknown[];
    // Original Organization caveat + new attenuating Organization
    // caveat with Mask: 1 (ActionRead).
    expect(caveats).toEqual([0, [12345, 31], 0, [12345, 1]]);

    // Tail must equal HMAC-SHA256(origTail, msgpack([0, [12345, 1]])).
    const opc = msgpackEncode([0, [12345, 1]], { useBigInt64: true });
    const expected = await hmac(origTail, opc);
    expect(Array.from(decoded[3] as Uint8Array)).toEqual(Array.from(expected));
  });

  it("throws when the macaroon has no Organization caveat", async () => {
    const nonce = [new Uint8Array([1]), new Uint8Array([2])];
    const noOrg = msgpackEncode(
      [nonce, "https://api.fly.io/v1", [], new Uint8Array(32)],
      { useBigInt64: true },
    );
    await expect(attenuateOrgReadOnly(noOrg)).rejects.toThrow(/Organization/);
  });

  it("is sensitive to the tail — different tails produce different outputs", async () => {
    const tailA = new Uint8Array(32).fill(0x01);
    const tailB = new Uint8Array(32).fill(0x02);
    const a = await attenuateOrgReadOnly(makePermMacaroon(1, 31, tailA));
    const b = await attenuateOrgReadOnly(makePermMacaroon(1, 31, tailB));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe("attenuateBundleOrgReadOnly", () => {
  it("attenuates the permission macaroon but passes the discharge through verbatim", async () => {
    const permTail = new Uint8Array(32).fill(0xab);
    const dischargeTail = new Uint8Array(32).fill(0xcd);
    const perm = makePermMacaroon(12345, 31, permTail);
    const nonce = [new Uint8Array([1]), new Uint8Array([2])];
    const discharge = msgpackEncode(
      [nonce, "https://api.fly.io/aaa/v1", [], dischargeTail],
      { useBigInt64: true },
    );
    const header = `FlyV1 fm2_${bytesToB64(perm)},fm2_${bytesToB64(discharge)}`;

    const out = await attenuateBundleOrgReadOnly(header);
    const segs = parseFlyTokens(out);
    expect(segs).toHaveLength(2);

    const dPerm = decodeMacaroon(segs[0]!);
    const dDis = decodeMacaroon(segs[1]!);
    expect(dPerm.location).toBe("https://api.fly.io/v1");
    expect(dDis.location).toBe("https://api.fly.io/aaa/v1");

    // The discharge segment should be bytewise-identical to what we
    // put in — no re-encode, no caveat injection.
    const origDischarge = parseFlyTokens(`FlyV1 fm2_${bytesToB64(discharge)}`)[0]!;
    expect(Array.from(segs[1]!)).toEqual(Array.from(origDischarge));
  });

  it("round-trips: encode → attenuate → decode preserves location and adds exactly one caveat", async () => {
    const tail = new Uint8Array(32).fill(0x42);
    const raw = makePermMacaroon(999, 31, tail);
    const header = `FlyV1 ${encodeFlyTokens([raw])}`;
    const out = await attenuateBundleOrgReadOnly(header);
    const decoded = msgpackDecode(parseFlyTokens(out)[0]!) as unknown[];
    expect((decoded[2] as unknown[]).length).toBe(4); // 2 caveats * 2
  });
});


function fixtureMacaroon(kid: number[], caveats: unknown[] = [], location = "https://fixture.test/aaa") {
  return msgpackEncode([[new Uint8Array(kid), new Uint8Array([9])], location, caveats, new Uint8Array(32)]);
}
const ticket = new Uint8Array([7, 8]);
const permission = fixtureMacaroon([1], [11, ["https://fixture.test/aaa", new Uint8Array([6]), ticket]]);
const discharge = fixtureMacaroon([7, 8]);
const header = `FlyV1 ${encodeFlyTokens([permission, discharge])},fo1_fixture-oauth`;

it("refreshes stale discharges, preserves permission prefixes/OAuth and sends the ticket/auth headers", async () => {
  mockFetch("https://fixture.test", async req => {
    expect(req.url).toBe("https://fixture.test/aaa/.well-known/macfly/3p");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe(header);
    expect(req.headers.get("accept")).toBe("application/json");
    expect(await req.json()).toEqual({ticket: bytesToB64(ticket)});
    return Response.json({discharge: `fm1a_${bytesToB64(discharge)}`});
  });
  expect(await dischargeBundle(header)).toBe(header);
  expect(await dischargeBundle(`fo1_fixture`)).toBe("FlyV1 fo1_fixture");
});

it("polls absolute/root/relative and interactive URLs, including pending responses", async () => {
  for (const [location, pollPath, url, interactive] of [
    ["https://fixture.test/aaa", "https://fixture.test/ready", "https://fixture.test/ready", false],
    ["https://fixture.test/aaa", "/ready", "https://fixture.test/ready", true],
    ["https://fixture.test/aaa/", "ready", "https://fixture.test/aaa/ready", false],
    ["https://fixture.test/aaa", "ready", "https://fixture.test/aaa/ready", false],
  ] as const) {
    let polls = 0;
    const bundle = `FlyV1 ${encodeFlyTokens([fixtureMacaroon([1], [11, [location, [], ticket]])])}`;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const req = new Request(input, init);
      expect(req.headers.get("authorization")).toBe(bundle);
      if (req.method === "POST") return Response.json(interactive ? {user_interactive: {poll_url: pollPath}} : {poll_url: pollPath});
      expect(req.url).toBe(url);
      return ++polls === 1 ? new Response(null, {status: 202}) : Response.json({discharge: bytesToB64(discharge)});
    });
    expect(parseFlyTokens(await dischargeBundle(bundle, {fetchImpl}))).toHaveLength(2);
    expect(polls).toBe(2);
  }
});

it("rejects HTTP, JSON and provider-envelope failures without leaking private content", async () => {
  const invalid = [null, [], 42, {error: "fixture-private"}, {discharge: 42}, {poll_url: 42}, {user_interactive: null}, {user_interactive: []}, {user_interactive: {poll_url: 42}}, {}];
  for (const polling of [false, true]) {
    for (const response of [new Response("fixture-private", {status: 403}), new Response(null, {status: 500}), new Response("fixture-private"), ...invalid.map(x => Response.json(x))]) {
      const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => polling && init?.method === "POST" ? Response.json({poll_url: "/poll"}) : response.clone());
      const error = await dischargeBundle(header, {fetchImpl}).then(() => undefined, error => error);
      expect(error).toBeInstanceOf(MacaroonError);
      expect(String(error)).not.toContain("fixture-private");
    }
  }
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({poll_url: "/poll"}));
  await expect(dischargeBundle(header, {fetchImpl, timeoutMs: 0})).rejects.toThrow("timed out");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("rejects malformed macaroon structures and byte fields", () => {
  for (const value of [null, [], [[], "location", [], []], [[[], []], 42, [], []], [[[], []], "location", [11], []], [[[], []], "location", [11, []], []], [[[], []], "location", [11, [42, [], []]], []], [["bad", []], "location", [], []], [[[], []], "location", [11, ["location", [], "bad"]], []]]) {
    expect(() => decodeMacaroon(msgpackEncode(value))).toThrow(MacaroonError);
  }
  expect(() => parseFlyTokenSegments("fm2_!invalid!")).toThrow("invalid token encoding");
  expect(() => parseFlyTokenSegments("unknown_fixture")).toThrow("unknown token prefix");
  expect(() => parseFlyTokenSegments(" , ")).toThrow("no tokens");
  expect(stripScheme("custom token")).toBe("custom token");
  expect(encodeFlyTokenSegments(parseFlyTokenSegments("fm1r_AQID,fo1_fixture"))).toBe("fm1r_AQID,fo1_fixture");
});

it("rejects invalid attenuation inputs and preserves unrelated/pass-through segments", async () => {
  for (const value of [null, [[], "location", [0], []], [[], "location", [0, []], []], [[], "location", [0, ["bad", 31]], []], [[], "location", [12, []], []]]) {
    await expect(attenuateOrgReadOnly(msgpackEncode(value))).rejects.toThrow(MacaroonError);
  }
  const unrelated = [msgpackEncode(42), msgpackEncode([[], 42, [], []]), discharge];
  const bundle = `${encodeFlyTokens(unrelated)},fo1_fixture`;
  expect(await attenuateBundleOrgReadOnly(bundle)).toBe(bundle);
  const bigintOrg = msgpackEncode([[[], []], "https://api.fly.io/v1", [0, [123n, 31]], new Uint8Array(32)], {useBigInt64:true});
  expect(decodeMacaroon(await attenuateOrgReadOnly(bigintOrg)).location).toBe("https://api.fly.io/v1");
});

it("accepts legacy numeric byte arrays and all supported discharge prefixes", async () => {
  const legacy = msgpackEncode([[[1, 2], [3]], "location", [11, ["https://fixture.test", [], [7, 8]]], [0]]);
  expect(Array.from(decodeMacaroon(legacy).nonceKid)).toEqual([1, 2]);
  expect(Array.from(decodeMacaroon(legacy).thirdPartyCaveats[0]!.ticket)).toEqual([7, 8]);
  const invalid = msgpackEncode([[[1, "bad"], []], "location", [], []]);
  expect(() => decodeMacaroon(invalid)).toThrow("expected bytes");
  for (const prefix of ["fm2", "fm1r", "fm1a"]) {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({discharge: `${prefix}_${bytesToB64(discharge)}`}));
    expect(parseFlyTokens(await dischargeBundle(header, {fetchImpl}))).toHaveLength(2);
  }
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({discharge: "unknown_fixture-private"}));
  await expect(dischargeBundle(header, {fetchImpl})).rejects.toThrow("invalid token encoding");
});
