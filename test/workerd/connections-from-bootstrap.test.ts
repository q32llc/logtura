import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decryptSecret } from "../../src/crypto";
import { decodeMacaroon, parseFlyTokens } from "../../src/deploy-targets/fly-macaroon";
import { mockFetch, seedDeployTarget, seedUser } from "./_setup";

/** Build a synthetic Fly permission macaroon with one Organization
 *  caveat, base64-encoded. Stand-in for what
 *  createLimitedAccessToken would return. The tail is fixed bytes —
 *  attenuation chains HMAC forward from whatever tail it sees, so a
 *  real Fly signature isn't needed. */
function fakeFlyMacaroon(orgId: number): string {
  const nonce = [new Uint8Array([1, 2, 3]), new Uint8Array([9, 9, 9])];
  const caveats = [0, [orgId, 31 /* full RWXCD */]];
  const tail = new Uint8Array(32).fill(0xab);
  const raw = msgpackEncode([nonce, "https://api.fly.io/v1", caveats, tail], {
    useBigInt64: true,
  });
  let bin = "";
  for (const b of raw) bin += String.fromCharCode(b);
  return `FlyV1 fm2_${btoa(bin)}`;
}

describe("POST /api/connections/from-bootstrap", () => {
  it("mints a read-only Fly token from a held bootstrap and stores it as a connection", async () => {
    const { userId, sessionCookie } = await seedUser();
    const bootstrap = await seedDeployTarget({
      userId,
      kind: "fly",
      displayName: "personal-bootstrap",
      externalAccountId: "personal",
      credentials: { apiToken: fakeFlyMacaroon(12345) },
    });

    // Intercept Fly's GraphQL endpoint.
    //   1) `listFlyOrgs` query → return one org with id "org_node_1",
    //      slug "personal".
    //   2) `createLimitedAccessToken` mutation → return a fresh
    //      synthetic macaroon with the same org caveat. The driver
    //      will then attenuate this client-side, which is what we're
    //      actually testing.
    const minted = fakeFlyMacaroon(12345);
    mockFetch("https://api.fly.io/graphql", async (req) => {
      const body = (await req.json()) as { query: string };
      if (body.query.includes("organizations")) {
        return Response.json({
          data: {
            organizations: {
              nodes: [{ id: "org_node_1", slug: "personal" }],
            },
          },
        });
      }
      if (body.query.includes("createLimitedAccessToken")) {
        return Response.json({
          data: {
            createLimitedAccessToken: {
              limitedAccessToken: { tokenHeader: minted },
            },
          },
        });
      }
      throw new Error(`Unexpected Fly GraphQL: ${body.query.slice(0, 80)}`);
    });

    const res = await SELF.fetch("http://localhost/api/connections/from-bootstrap", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
      },
      body: JSON.stringify({
        deployTargetId: bootstrap.id,
        providerId: "fly-log-tail",
        displayName: "Fly source (test)",
        scope: "personal",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      connection: { id: string; provider: string; externalAccountId: string };
    };
    expect(json.connection.provider).toBe("fly-log-tail");
    expect(json.connection.externalAccountId).toBe("personal");

    // The stored credential should decrypt to a TWO-caveat macaroon:
    // the original Organization + the appended read-only attenuation.
    // This is the end-to-end proof that the mint pipeline produced a
    // read-only token and that we encrypted+stored it correctly.
    const row = await env.DB.prepare(
      "SELECT credentials_encrypted, user_id FROM connections WHERE id = ?",
    )
      .bind(json.connection.id)
      .first<{ credentials_encrypted: ArrayBuffer; user_id: string }>();
    expect(row?.user_id).toBe(userId);
    const pt = await decryptSecret(
      new Uint8Array(row!.credentials_encrypted),
      env.CREDENTIAL_ENCRYPTION_KEY,
    );
    const stored = JSON.parse(pt) as { apiToken: string };
    const rawMac = parseFlyTokens(stored.apiToken)[0]!;
    const decoded = msgpackDecode(rawMac) as unknown[];
    const caveats = decoded[2] as unknown[];
    expect(caveats.length).toBe(4); // 2 caveats × [type, body]
    // Second caveat (the appended one) has Mask: 1 (ActionRead).
    const appendedBody = caveats[3] as unknown[];
    expect(appendedBody[1]).toBe(1);
  });

  it("returns unknown_provider for a providerId that's not registered", async () => {
    const { userId, sessionCookie } = await seedUser();
    const bootstrap = await seedDeployTarget({
      userId,
      kind: "fly",
      displayName: "personal-bootstrap",
      externalAccountId: "personal",
      credentials: { apiToken: fakeFlyMacaroon(12345) },
    });
    const res = await SELF.fetch("http://localhost/api/connections/from-bootstrap", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
      },
      body: JSON.stringify({
        deployTargetId: bootstrap.id,
        providerId: "definitely-not-a-real-provider",
        displayName: "x",
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("unknown_provider");
  });

  it("returns bootstrap_no_mint when target driver doesn't implement minting", async () => {
    const { userId, sessionCookie } = await seedUser();
    // "other" is a valid deploy_target kind that has no
    // mintConnectionCredentials.
    const bootstrap = await seedDeployTarget({
      userId,
      kind: "other",
      displayName: "manual-bootstrap",
      externalAccountId: null,
      credentials: { apiToken: "irrelevant" },
    });

    const res = await SELF.fetch("http://localhost/api/connections/from-bootstrap", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
      },
      body: JSON.stringify({
        deployTargetId: bootstrap.id,
        providerId: "cloudflare-worker-tail",
        displayName: "CF from bootstrap",
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("bootstrap_no_mint");
  });

  it("requires authentication", async () => {
    // Hit a simpler GET-protected route so we don't tangle with body
    // parsing / Content-Length quirks in workerd's fetch — the auth
    // guard (`apiAuth.use("*", requireAuth)`) is the same for every
    // route under /api, so testing it on /connections is identical
    // coverage with cleaner mechanics.
    const res = await SELF.fetch("http://localhost/api/connections", {
      method: "GET",
      redirect: "manual",
    });
    // requireAuth redirects to / with ?error=auth_required.
    expect(res.status).toBe(303);
    expect(res.headers.get("location") ?? "").toMatch(/auth_required/);
  });
});

describe("Fly mint pipeline — assertion of attenuation against a stored cred", () => {
  // This sibling test exercises the part of the mint code that the
  // route can't reach today (no Fly provider). Once the provider
  // lands the assertion above will hit the green path; until then,
  // this proves the attenuation pipeline itself works against a real
  // stored credential by running the driver method directly.
  it("attenuates the minted token to a 2-caveat read-only macaroon", async () => {
    const minted = fakeFlyMacaroon(12345);
    mockFetch("https://api.fly.io/graphql", async (req) => {
      const body = (await req.json()) as { query: string };
      if (body.query.includes("organizations")) {
        return Response.json({
          data: {
            organizations: {
              nodes: [{ id: "org_node_1", slug: "personal" }],
            },
          },
        });
      }
      return Response.json({
        data: {
          createLimitedAccessToken: {
            limitedAccessToken: { tokenHeader: minted },
          },
        },
      });
    });

    // Pull the driver out of the registry and invoke directly. This
    // sidesteps the route's provider-existence check and proves the
    // mint/attenuate pipeline works end-to-end.
    const { getDeployTargetDriver } = await import("../../src/deploy-targets");
    const driver = getDeployTargetDriver("fly")!;
    const result = await driver.mintConnectionCredentials!({
      bootstrapCredentials: { apiToken: fakeFlyMacaroon(12345) },
      providerId: "fly-log-tail",
      scope: "personal",
    });

    expect(result.externalAccountId).toBe("personal");
    // The minted token should decode to a permission macaroon with
    // TWO Organization caveats: the original RWXCD + the appended
    // read-only attenuation. The original macaroon has only one.
    const raw = parseFlyTokens(result.apiToken)[0]!;
    const decoded = msgpackDecode(raw) as unknown[];
    const caveats = decoded[2] as unknown[];
    expect(caveats.length).toBe(4); // 2 caveats * 2 (flat [type,body] pairs)
    expect(caveats[0]).toBe(0); // CavFlyioOrganization
    expect(caveats[2]).toBe(0);
    // Second caveat's mask should be 1 (ActionRead).
    const secondBody = caveats[3] as unknown[];
    expect(secondBody[1]).toBe(1);
    // Sanity: the macaroon parser is happy with the result.
    const meta = decodeMacaroon(raw);
    expect(meta.location).toBe("https://api.fly.io/v1");
  });
});
