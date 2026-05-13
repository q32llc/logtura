import { describe, expect, it } from "vitest";
import {
  customVectorDestination,
  customVectorProvider,
} from "../src/index";

const connection = {
  id: "con_custom",
  externalAccountId: null,
  displayName: "custom",
};

describe("customVectorProvider", () => {
  it("renders included sources/transforms and exposes the declared feed", () => {
    const pipe = customVectorProvider.generatePipeline({
      connection,
      selection: {
        kind: "list",
        sources: [
          {
            id: "src_custom",
            externalId: "bob_norm",
            displayName: "Bob",
            sourceKind: "custom_vector",
            metadata: {
              customVector: {
                feed: "bob_norm",
                fragment: {
                  sources: {
                    bob_http: {
                      type: "http_server",
                      address: "0.0.0.0:9000",
                    },
                  },
                  transforms: {
                    bob_norm: {
                      type: "remap",
                      inputs: ["bob_http"],
                      source: ".message = string(.message) ?? encode_json(.)",
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });
    expect(pipe.components.map((c) => c.key)).toEqual([
      "custom_con_custom_bob_http",
      "custom_con_custom_bob_norm",
    ]);
    expect(pipe.outputKey).toBe("custom_con_custom_bob_norm");
    expect(pipe.components[1]!.yaml).toContain(
      'inputs:\n      - custom_con_custom_bob_http',
    );
  });

  it("rejects source fragments that define sinks", () => {
    expect(() =>
      customVectorProvider.generatePipeline({
        connection,
        selection: {
          kind: "list",
          sources: [
            {
              id: "src_custom",
              externalId: "bad",
              displayName: "Bad",
              sourceKind: "custom_vector",
              metadata: {
                customVector: {
                  feed: "bad",
                  fragment: { sinks: { bad: { type: "blackhole" } } },
                },
              },
            },
          ],
        },
      }),
    ).toThrow(/cannot define sinks/);
  });
});

describe("customVectorDestination", () => {
  it("rewrites a single dangling input into the Logtura monitor input", () => {
    const bundle = customVectorDestination.generateSinkBundle({
      config: {
        fragment: {
          transforms: {
            joe_format: {
              type: "remap",
              inputs: ["joe_in"],
              source: ".custom = true",
            },
          },
          sinks: {
            joe_sink: {
              type: "blackhole",
              inputs: ["joe_format"],
            },
          },
        },
      },
      inputs: ["monitor_out"],
      sinkKey: "sink_joe",
      envVarName: "IGNORED",
    });
    expect(bundle.preSinkTransforms?.[0]?.key).toBe(
      "custom_sink_joe_joe_format",
    );
    expect(bundle.preSinkTransforms?.[0]?.yaml).toContain(
      "inputs:\n      - monitor_out",
    );
    expect(bundle.sinks?.[0]?.key).toBe("custom_sink_joe_joe_sink");
    expect(bundle.sinks?.[0]?.yaml).toContain(
      "inputs:\n      - custom_sink_joe_joe_format",
    );
  });

  it("rejects ambiguous dangling destination inputs without vector.input", () => {
    expect(() =>
      customVectorDestination.generateSinkBundle({
        config: {
          fragment: {
            sinks: {
              a: { type: "blackhole", inputs: ["a_in"] },
              b: { type: "blackhole", inputs: ["b_in"] },
            },
          },
        },
        inputs: ["monitor_out"],
        sinkKey: "sink_joe",
        envVarName: "IGNORED",
      }),
    ).toThrow(/requires vector.input/);
  });
});
