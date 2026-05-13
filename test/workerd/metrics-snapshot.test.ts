import { describe, expect, it } from "vitest";
import {
  applyMetricsToSnapshot,
  parseMetricsBody,
  rateFor,
} from "../../src/metrics-snapshot";

function metric(
  name: string,
  value: number,
  timestamp: string,
): Record<string, unknown> {
  return {
    name,
    namespace: "vector",
    timestamp,
    tags: {
      component_id: "sink_slack",
      component_kind: "sink",
      component_type: "http",
    },
    counter: { value },
  };
}

describe("metrics snapshots", () => {
  it("keeps per-field timestamps so sink sent rate survives same-batch counters", () => {
    const first = parseMetricsBody(
      JSON.stringify([
        metric("component_received_events_total", 1, "2026-05-13T00:00:00.000Z"),
        metric("component_sent_events_total", 1, "2026-05-13T00:00:00.000Z"),
      ]),
    );
    const second = parseMetricsBody(
      JSON.stringify([
        metric("component_received_events_total", 2, "2026-05-13T00:01:00.000Z"),
        metric("component_sent_events_total", 2, "2026-05-13T00:01:00.000Z"),
      ]),
    );

    const snap = applyMetricsToSnapshot(
      applyMetricsToSnapshot(null, first),
      second,
    );
    const sink = snap.byComponent.sink_slack!;

    expect(sink.sent).toBe(2);
    expect(sink.prev?.sent).toBe(1);
    expect(rateFor(sink, "sent")).toBe(1);
  });
});
