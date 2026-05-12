/** Fast unit tests for the cloudflare-worker-tail driver. Pure
 *  shapes only: no docker, no fetch network. The black-box
 *  "the YAML this driver emits parses through vector validate"
 *  check lives in vector-validate.test.ts. */
import { describe, expect, it, vi } from "vitest";
import { cloudflareWorkerTailDriver } from "../src/index";

const dummyConnection = {
  id: "con_x",
  externalAccountId: "acct_x",
  displayName: "test",
};

const workerSource = (id: string, name: string) => ({
  id,
  externalId: name,
  displayName: name,
  sourceKind: "cf_worker",
  metadata: null,
});

// parseFormData + connectFlow + formFields live in the SaaS-side
// connect adapter (src/providers/connect/cloudflare-worker-tail.ts).

describe("capabilities", () => {
  it("declares list-only selection (wrangler tail is per-script)", () => {
    expect(cloudflareWorkerTailDriver.capabilities.selection).toBe("list");
  });
});

describe("generatePipeline", () => {
  it("rejects all-selection", () => {
    expect(() =>
      cloudflareWorkerTailDriver.generatePipeline({
        connection: dummyConnection,
        selection: { kind: "all" },
      }),
    ).toThrow(/does not support "all"/);
  });

  it("emits one exec source per worker + a normalize transform", () => {
    const pipe = cloudflareWorkerTailDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [
          workerSource("src_a", "my-worker"),
          workerSource("src_b", "other-worker"),
        ],
      },
    });
    const sources = pipe.components.filter((c) => c.kind === "source");
    const transforms = pipe.components.filter((c) => c.kind === "transform");
    expect(sources).toHaveLength(2);
    expect(transforms).toHaveLength(1);
    expect(pipe.outputKey).toBe(transforms[0]!.key);
    // Connection-scoped keys so multiple CF accounts can coexist
    // in one bundle without colliding on identically-named workers.
    expect(sources[0]!.key).toBe("cf_worker_con_x_my_worker");
    expect(sources[0]!.yaml).toContain("type: exec");
    expect(sources[0]!.yaml).toContain(
      "wrangler tail my-worker --format json",
    );
    expect(sources[0]!.yaml).toContain("jq -c --unbuffered");
  });

  it("refuses shell-suspicious worker names", () => {
    expect(() =>
      cloudflareWorkerTailDriver.generatePipeline({
        connection: dummyConnection,
        selection: {
          kind: "list",
          sources: [workerSource("src_a", "evil; rm -rf /")],
        },
      }),
    ).toThrow(/suspicious worker name/);
  });

  it("normalize remap classifies error vs warn vs info from outcome + logs", () => {
    const pipe = cloudflareWorkerTailDriver.generatePipeline({
      connection: dummyConnection,
      selection: { kind: "list", sources: [workerSource("src_a", "a")] },
    });
    const norm = pipe.components.find((c) => c.kind === "transform")!;
    const y = norm.yaml;
    expect(y).toContain("type: remap");
    // Per-event level: structured-log scan + outcome classifier.
    expect(y).toContain("has_error_log");
    expect(y).toContain("worker_failed");
    expect(y).toContain("client_aborted");
    // [script] prefix in the synthesized message body. Source-side
    // tagging so non-rollup monitors still ship a labeled body.
    expect(y).toContain('"[" + .script + "] "');
    // Worker-failure outcomes prefix the body with outcome=<reason>.
    // Regression pin: previously, a request that logged anything
    // before CF killed it (exceededMemory, exceededCpu, etc.)
    // showed only the surviving info logs, hiding the real cause.
    expect(y).toContain(
      'else if worker_failed { "outcome=" + outcome + " | " + join!(parts, " | ") }',
    );
  });

  it("declares CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env vars", () => {
    const pipe = cloudflareWorkerTailDriver.generatePipeline({
      connection: dummyConnection,
      selection: { kind: "list", sources: [workerSource("src_a", "a")] },
    });
    const names = pipe.envVars.map((e) => e.name);
    expect(names).toContain("CLOUDFLARE_API_TOKEN");
    expect(names).toContain("CLOUDFLARE_ACCOUNT_ID");
    // The wrangler dep needs node + npm; the driver bakes this into
    // the Dockerfile contribution.
    expect(pipe.dockerfileDeps[0]?.install).toContain("wrangler@latest");
  });

  it("manifest echoes Source.id for host UI linking", () => {
    const pipe = cloudflareWorkerTailDriver.generatePipeline({
      connection: dummyConnection,
      selection: {
        kind: "list",
        sources: [workerSource("src_chosen", "my-worker")],
      },
    });
    const sourceEntry = (pipe.manifest ?? []).find(
      (m) => m.role === "source",
    );
    expect(sourceEntry?.links?.sourceId).toBe("src_chosen");
    expect(sourceEntry?.links?.connectionId).toBe("con_x");
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
