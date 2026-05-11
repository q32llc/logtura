import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import {
  attenuateBundleOrgReadOnly,
  attenuateOrgReadOnly,
  decodeMacaroon,
  encodeFlyTokens,
  parseFlyTokens,
  parseFlyTokenSegments,
  stripScheme,
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
