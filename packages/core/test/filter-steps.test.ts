import { describe, expect, it } from "vitest";
import { generateBundle } from "../src";
import type { FilterStep, GeneratorMonitor } from "../src";
import { mockDestination, mockProvider } from "./_fixtures";

/** Per-FilterStep emission tests. Each kind compiled in isolation
 *  through generateBundle. When `renderStepTransforms` graduates
 *  into a real plugin layer these tests move with it; for now
 *  they pin the per-step output. */

function bundleWith(filterSteps: FilterStep[]): {
  yaml: string;
  monitorId: string;
} {
  const monitor: GeneratorMonitor = {
    monitor: {
      id: "mon_x",
      connectionId: null,
      displayName: "test",
      filterSteps,
      enabled: true,
    },
    sinks: [
      {
        sink: { id: "snk_y", filterSteps: [] },
        destination: {
          id: "dst_z",
          kind: "mock-sink",
          displayName: "Test sink",
        },
        destinationConfig: { url: "https://example.com/hook" },
      },
    ],
  };
  const bundle = generateBundle({
    providers: [mockProvider],
    destinations: [mockDestination],
    connections: [
      {
        connection: {
          id: "con_a",
          provider: "mock-source",
          displayName: "A",
          externalAccountId: "acct_x",
        },
        selectedSources: [
          {
            id: "s_a",
            externalId: "thing",
            displayName: "thing",
            sourceKind: "mock",
            metadata: null,
          },
        ],
      },
    ],
    monitors: [monitor],
  });
  return { yaml: bundle.vectorYaml, monitorId: "mon_x" };
}

describe("FilterStep emission", () => {
  it("errors → filter on .error or .level == 'error'", () => {
    const { yaml } = bundleWith([{ kind: "errors" }]);
    expect(yaml).toContain("monitor_mon_x_0_errors:");
    expect(yaml).toContain("type: filter");
    expect(yaml).toContain("bool(.error)");
    expect(yaml).toContain('string(.level) ?? ""');
  });

  it("level include → filter on .level == <level>", () => {
    const { yaml } = bundleWith([
      { kind: "level", level: "warn", mode: "include" },
    ]);
    expect(yaml).toContain("type: filter");
    expect(yaml).toMatch(/== "warn"/);
  });

  it("level exclude → filter inverts the comparison", () => {
    const { yaml } = bundleWith([
      { kind: "level", level: "debug", mode: "exclude" },
    ]);
    expect(yaml).toMatch(/!= "debug"/);
  });

  it("match → filter with a regex against the chosen field", () => {
    const { yaml } = bundleWith([
      {
        kind: "match",
        pattern: "timeout|refused",
        mode: "include",
        field: "message",
      },
    ]);
    expect(yaml).toContain("type: filter");
    expect(yaml).toContain("match(string(.message)");
    expect(yaml).toContain("r'timeout|refused'");
  });

  it("rate_limit → throttle transform", () => {
    const { yaml } = bundleWith([{ kind: "rate_limit", per_minute: 120 }]);
    expect(yaml).toContain("type: throttle");
    expect(yaml).toContain("threshold: 120");
  });

  it("sample → sample transform", () => {
    const { yaml } = bundleWith([{ kind: "sample", rate: 0.5 }]);
    expect(yaml).toContain("type: sample");
  });

  it("dedup → dedupe transform", () => {
    const { yaml } = bundleWith([
      { kind: "dedup", window_secs: 60, fields: ["message", "script"] },
    ]);
    expect(yaml).toContain("type: dedupe");
  });

  it("rollup → three chained transforms (pre + reduce + fmt)", () => {
    const { yaml } = bundleWith([
      {
        kind: "rollup",
        window_secs: 30,
        group_by: ["script"],
        max_samples: 5,
      },
    ]);
    expect(yaml).toContain("monitor_mon_x_0_rollup_pre:");
    expect(yaml).toContain("monitor_mon_x_0_rollup_reduce:");
    expect(yaml).toContain("monitor_mon_x_0_rollup_fmt:");
    expect(yaml).toContain("type: reduce");
    // Group-by key prefix in the formatted message.
    expect(yaml).toContain('string(.script) ?? "?"');
    // Pinned earlier bug: int → string cast is to_string not string.
    expect(yaml).toContain("to_string(n)");
  });

  it("chain of multiple steps → each step inputs from prior", () => {
    const { yaml } = bundleWith([
      { kind: "errors" },
      { kind: "dedup", window_secs: 60, fields: ["message"] },
      { kind: "rollup", window_secs: 30, group_by: [], max_samples: 3 },
    ]);
    expect(yaml).toContain("monitor_mon_x_0_errors:");
    expect(yaml).toContain("monitor_mon_x_1_dedup:");
    expect(yaml).toContain("monitor_mon_x_2_rollup_pre:");
    expect(yaml).toMatch(
      /monitor_mon_x_1_dedup:[\s\S]*?inputs: \["monitor_mon_x_0_errors"\]/,
    );
    expect(yaml).toMatch(
      /monitor_mon_x_2_rollup_pre:[\s\S]*?inputs: \["monitor_mon_x_1_dedup"\]/,
    );
  });
});
