import { describe, expect, it } from "vitest";
import { generateBundle, parseConfigDocument, normalizeConfigDocument, hashConfigDocument } from "@logtura/core";
import { cloudflareWorkerTailDriver } from "@logtura/driver-cloudflare-worker-tail";
import { webhookDriver } from "@logtura/destination-webhook";

// The very same public parsing/revision APIs run in workerd, with no Node CLI,
// filesystem, ambient process environment or provider HTTP request.
describe("public portable config in workerd", () => {
  it("renders stable inputs and hashes unresolved credentials with Workers crypto", async () => {
    const doc={providers:{cloudflare:{account_id:"fixture",credentials:{api_token:"env:TOKEN"}}},sources:{workers:{scripts:["api"]}},sinks:{alerts:{sink:"webhook",url:"env:URL"}},monitors:[{name:"errors",source:"workers",sinks:["alerts"]}]};
    const options={providers:[cloudflareWorkerTailDriver],destinations:[webhookDriver],env:{TOKEN:"fixture-token",URL:"https://fixture.test"}};
    const parsed=parseConfigDocument(doc,options);
    const stable=normalizeConfigDocument(doc,options);
    expect(parseConfigDocument(stable,options)).toEqual(parsed);
    expect(generateBundle(parsed.input).envVars.some(v=>v.value==="fixture-token")).toBe(true);
    expect(await hashConfigDocument(stable)).toBe(await hashConfigDocument(doc));
    expect(await hashConfigDocument(stable)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
