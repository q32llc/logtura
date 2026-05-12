/** Fast unit tests for the cloudflare-worker-tail driver. Pure
 *  shapes only — no docker, no fetch network. The black-box
 *  "the YAML this driver emits parses through vector validate"
 *  check lives in vector-validate.test.ts. */
import { describe, expect, it, vi } from "vitest";
import { cloudflareWorkerTailDriver } from "../src/index";

const dummyConnection = {
  id: "con_x",
  provider: "cloudflare-worker-tail",
  displayName: "test",
  externalAccountId: "acct_x",
};

// parseFormData + connectFlow + formFields moved to the SaaS-side
// connect adapter (src/providers/connect/cloudflare-worker-tail.ts);
// see test/workerd/connect-adapters.test.ts for those tests.

describe("generateSourceBlock", () => {
  it("emits a wrangler tail exec command with json + jq pipeline", () => {
    const block = cloudflareWorkerTailDriver.generateSourceBlock({
      source: {
        id: "src_a",
        externalId: "my-worker",
        displayName: "my-worker",
        sourceKind: "cf_worker",
        metadata: null,
      },
      connection: dummyConnection,
    });
    expect(block.key).toBe("cf_worker_my_worker");
    expect(block.yaml).toContain("type: exec");
    expect(block.yaml).toContain("wrangler tail my-worker --format json");
    expect(block.yaml).toContain("jq -c --unbuffered");
    expect(block.yaml).toContain("codec: json");
  });

  it("refuses shell-suspicious worker names", () => {
    expect(() =>
      cloudflareWorkerTailDriver.generateSourceBlock({
        source: {
          id: "src_a",
          externalId: "evil; rm -rf /",
          displayName: "evil",
          sourceKind: "cf_worker",
          metadata: null,
        },
        connection: dummyConnection,
      }),
    ).toThrow(/suspicious worker name/);
  });
});

describe("generateNormalize", () => {
  it("returns null when no inputs are wired", () => {
    expect(
      cloudflareWorkerTailDriver.generateNormalize!({
        inputKeys: [],
        connection: dummyConnection,
        sources: [],
      }),
    ).toBeNull();
  });

  it("emits a remap with the worker level/error classifier", () => {
    const norm = cloudflareWorkerTailDriver.generateNormalize!({
      inputKeys: ["cf_worker_a", "cf_worker_b"],
      connection: dummyConnection,
      sources: [],
    });
    expect(norm?.key).toBe("cf_worker_norm");
    const y = norm!.yaml;
    expect(y).toContain('inputs: ["cf_worker_a", "cf_worker_b"]');
    expect(y).toContain("type: remap");
    // Per-event level: structured-log scan + outcome classifier.
    expect(y).toContain("has_error_log");
    expect(y).toContain("worker_failed");
    expect(y).toContain("client_aborted");
    // [script] prefix in the synthesized message body — source-side
    // tagging so non-rollup monitors still ship a labeled body.
    expect(y).toContain('"[" + .script + "] "');
    // Worker-failure outcomes prefix the body with outcome=<reason>.
    // Regression pin: previously, a request that logged anything
    // before CF killed it (exceededMemory, exceededCpu, etc.) showed
    // only the surviving info logs in Slack, hiding the real cause.
    expect(y).toContain(
      'else if worker_failed { "outcome=" + outcome + " | " + join!(parts, " | ") }',
    );
  });
});

describe("runtimeSpec", () => {
  it("declares CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env vars", () => {
    const spec = cloudflareWorkerTailDriver.runtimeSpec(dummyConnection);
    const names = spec.envVars.map((e) => e.name);
    expect(names).toContain("CLOUDFLARE_API_TOKEN");
    expect(names).toContain("CLOUDFLARE_ACCOUNT_ID");
    // The wrangler dep needs node + npm; the driver bakes this into
    // the Dockerfile contribution.
    expect(spec.dockerfileDeps[0]?.install).toContain("wrangler@latest");
  });
});

describe("discoverSources", () => {
  it("maps Cloudflare workers/scripts to DiscoveredSource", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: [
            { id: "alpha", modified_on: "2026-01-01T00:00:00Z" },
            { id: "beta" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const sources = await cloudflareWorkerTailDriver.discoverSources({
      credentials: { apiToken: "cfat_test" },
      accountId: "f0c6ed442ab8c6bf9d102678d9421dd8",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]![0]).toMatch(
      /\/accounts\/f0c6ed442ab8c6bf9d102678d9421dd8\/workers\/scripts$/,
    );
    expect(sources).toEqual([
      {
        sourceKind: "cf_worker",
        externalId: "alpha",
        displayName: "alpha",
        metadata: { modified_on: "2026-01-01T00:00:00Z" },
      },
      {
        sourceKind: "cf_worker",
        externalId: "beta",
        displayName: "beta",
        metadata: { modified_on: null },
      },
    ]);
    fetchSpy.mockRestore();
  });
});
