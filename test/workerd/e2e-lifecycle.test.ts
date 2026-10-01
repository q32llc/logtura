import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { seedUser } from "./_setup";
import { runRoutingLifecycle } from "../e2e/lifecycle";

it("exercises the HTTP routing lifecycle and removes only its own resources", async () => {
  const user = await seedUser();
  await expect(runRoutingLifecycle({
    baseUrl: "http://localhost", fetch: (request) => SELF.fetch(request),
    sessionCookie: user.sessionCookie, expectedUserId: user.userId,
    runId: crypto.randomUUID(),
  })).resolves.toBeUndefined();
});
