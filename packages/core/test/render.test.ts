import { describe, expect, it } from "vitest";
import { generateBundle } from "../src";
import type {
  Connection,
  LogturaEvent,
  GeneratorMonitor,
  Source,
} from "../src";
import {
  mockDestination,
  mockProvider,
  mockProviderWithAsset,
} from "./_fixtures";

/** Pure-logic tests for the renderer. No D1, no auth, no I/O —
 *  feed plain shapes in, assert on the structured output and the
 *  yaml string. */

const conn = (
  id: string,
  provider: string,
  displayName: string,
): Connection => ({
  id,
  provider,
  displayName,
  externalAccountId: "acct_x",
});

const src = (id: string, externalId: string): Source => ({
  id,
  externalId,
  displayName: externalId,
  sourceKind: "mock",
  metadata: null,
});

describe("generateBundle", () => {
  it("exports the canonical LogturaEvent shape", () => {
    const event: LogturaEvent = {
      message: "boom",
      level: "error",
      error: true,
      error_reason: "exception",
      exceptions: [{ name: "Error", message: "boom", stack: "stack" }],
    };
    expect(event.error).toBe(true);
  });

  it("throws when no connections are supplied", () => {
    expect(() =>
      generateBundle({
        providers: [mockProvider],
        destinations: [mockDestination],
        connections: [],
        monitors: [],
      }),
    ).toThrow(/at least one connection/);
  });

  it("throws when a connection's provider isn't in the registry", () => {
    expect(() =>
      generateBundle({
        providers: [],
        destinations: [],
        connections: [
          {
            connection: conn("con_a", "not-registered", "Test"),
            selectedSources: [],
          },
        ],
        monitors: [],
      }),
    ).toThrow(/Unknown provider/);
  });

  it("emits a heartbeat-only pipeline when no sources are selected", () => {
    const bundle = generateBundle({
      providers: [mockProvider],
      destinations: [mockDestination],
      connections: [
        {
          connection: conn("con_a", "mock-source", "Test"),
          selectedSources: [],
        },
      ],
      monitors: [],
      heartbeat: {
        kind: "logtura",
        deploymentId: "dep_test",
        appUrl: "https://example.com",
      },
    });
    expect(bundle.selectedCount).toBe(0);
    expect(bundle.vectorYaml).toContain("heartbeat_pulse:");
    expect(bundle.vectorYaml).toContain("heartbeat_logtura:");
    // No source-driven plumbing.
    expect(bundle.vectorYaml).not.toMatch(/mock_con_[A-Za-z0-9_-]+_norm:/);
    expect(bundle.vectorYaml).not.toContain("tag_received:");
  });

  it("composes sources, normalize, tag chain, and the manifest for a one-source pipeline", () => {
    const bundle = generateBundle({
      providers: [mockProvider],
      destinations: [mockDestination],
      connections: [
        {
          connection: conn("con_a", "mock-source", "MockConn"),
          selectedSources: [src("s_a", "thing-one")],
          credentials: { apiToken: "tok_inline" },
        },
      ],
      monitors: [],
    });
    expect(bundle.selectedCount).toBe(1);
    const y = bundle.vectorYaml;
    // Component keys are connection-scoped (the driver picks the
    // shape; this mock uses mock_<conn>_<source> and mock_<conn>_norm).
    expect(y).toContain("mock_con_a_thing_one:");
    expect(y).toContain("mock_con_a_norm:");
    expect(y).toMatch(/tag_conn_con_[A-Za-z0-9_-]+:/);
    expect(y).toContain("tag_received:");
    // Credential value flows into envVars.
    const tokenEnv = bundle.envVars.find((v) => v.name === "MOCK_API_TOKEN");
    expect(tokenEnv?.value).toBe("tok_inline");
    // Primary manifest row. The driver echoed back Source.id via
    // links.sourceId, so consumers can pair the manifest entry with
    // the picked source.
    const sources = bundle.componentManifest.filter((c) => c.role === "source");
    expect(sources).toHaveLength(1);
    expect(sources[0]!.label).toBe("Thing · thing-one");
    expect(sources[0]!.links?.sourceId).toBe("s_a");
  });

  it("dedups env vars across multiple connections of different drivers", () => {
    // Build a second driver that also declares MOCK_API_TOKEN (the
    // ID collision is the point — defensively the renderer should
    // emit one entry, not two).
    const otherProvider = { ...mockProvider, id: "other-source" };
    const bundle = generateBundle({
      providers: [mockProvider, otherProvider],
      destinations: [mockDestination],
      connections: [
        {
          connection: conn("con_a", "mock-source", "A"),
          selectedSources: [src("s_a", "alpha")],
        },
        {
          connection: conn("con_b", "other-source", "B"),
          selectedSources: [src("s_b", "beta")],
        },
      ],
      monitors: [],
    });
    const tokenEntries = bundle.envVars.filter(
      (v) => v.name === "MOCK_API_TOKEN",
    );
    expect(tokenEntries).toHaveLength(1);
  });

  it("renders one tag_conn per connection and a single tag_received fan-in", () => {
    const otherProvider = { ...mockProvider, id: "other-source" };
    const bundle = generateBundle({
      providers: [mockProvider, otherProvider],
      destinations: [mockDestination],
      connections: [
        {
          connection: conn("con_a", "mock-source", "A"),
          selectedSources: [src("s_a", "alpha")],
        },
        {
          connection: conn("con_b", "other-source", "B"),
          selectedSources: [src("s_b", "beta")],
        },
      ],
      monitors: [],
    });
    const tagConnLines = bundle.vectorYaml.match(/^  tag_conn_/gm) ?? [];
    expect(tagConnLines).toHaveLength(2);
    expect(bundle.vectorYaml).toContain("tag_received:");
  });

  it("routes a monitor's sink through pre-sink format + the destination's sink", () => {
    const monitor: GeneratorMonitor = {
      monitor: {
        id: "mon_x",
        connectionId: null,
        displayName: "errors",
        filterSteps: [{ kind: "errors" }],
        enabled: true,
      },
      sinks: [
        {
          sink: { id: "snk_y", filterSteps: [] },
          destination: { id: "dst_z", kind: "mock-sink", displayName: "Test" },
          destinationConfig: { url: "https://example.com/hook" },
        },
      ],
    };
    const bundle = generateBundle({
      providers: [mockProvider],
      destinations: [mockDestination],
      connections: [
        {
          connection: conn("con_a", "mock-source", "A"),
          selectedSources: [src("s_a", "alpha")],
        },
      ],
      monitors: [monitor],
    });
    expect(bundle.vectorYaml).toContain("monitor_mon_x_0_errors:");
    expect(bundle.vectorYaml).toContain("sink_snk_y_format:");
    expect(bundle.vectorYaml).toMatch(/^  sink_snk_y:/m);
    // Manifest carries a primary "sink" row + plumbing entries for
    // each transform.
    const sinks = bundle.componentManifest.filter((c) => c.role === "sink");
    expect(sinks).toHaveLength(1);
    expect(sinks[0]!.label).toBe("Mock sink · Test");
  });

  it("collects driver runtime assets and copies assets in the Dockerfile", () => {
    const bundle = generateBundle({
      providers: [mockProviderWithAsset],
      destinations: [mockDestination],
      connections: [
        {
          connection: conn("con_a", "mock-source-with-asset", "A"),
          selectedSources: [src("s_a", "alpha")],
        },
      ],
      monitors: [],
    });
    expect(bundle.runtimeAssets).toEqual([
      {
        driverId: "mock-source-with-asset",
        path: "bin/mock-helper.sh",
        content: "#!/bin/sh\necho mock\n",
        mode: 0o755,
      },
    ]);
    expect(bundle.dockerfile).toContain("COPY assets/ /opt/logtura/assets/");
  });
});
