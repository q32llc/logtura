import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import type { ApiComponentManifestEntry, ApiDeployment, ApiMetricsComponent, ApiMetricsSnapshot, ApiTargetBundle } from "../types";
import { DeploymentDetail } from "./DeploymentDetail";

const now = Date.now();
const deployment: ApiDeployment = { id: "dep_metrics", connectionId: "con_fixture", displayName: "Metrics fixture", targetKind: "other", managed: false, status: "running", externalId: null, sourceIds: [], monitorIds: [], heartbeatTarget: "logtura", metricsTarget: "logtura", metricsSnapshot: null, bundleOutdated: false, createdAt: 0, updatedAt: 0, lastSeenAt: now };
const bundle: ApiTargetBundle = { target: { id: "other", displayName: "Other", supportsManaged: false }, files: [], envVars: [], selfDeployInstructions: "Run", selectedCount: 0, monitorSummary: "No monitors", componentManifest: [] };
const counters = { received: 0, sent: 0, errors: 0, discarded: 0 };
function component(kind: ApiMetricsComponent["kind"], sent: number, previous: number, extra: Partial<ApiMetricsComponent> = {}): ApiMetricsComponent { return { kind, type: kind === "sink" ? "http" : "exec", sent, lastSeen: now, prev: { sent: previous, sampleAt: now - 60_000 }, ...extra }; }
function snapshot(byComponent: ApiMetricsSnapshot["byComponent"], extra: Partial<ApiMetricsSnapshot> = {}): ApiMetricsSnapshot { return { byComponent, totals: counters, lifetimeOffset: counters, updatedAt: now, processStartAt: now - 3600_000, vectorVersion: "0.55.0", ...extra }; }
function manifest(id: string, role: ApiComponentManifestEntry["role"], label: string, parentId?: string): ApiComponentManifestEntry { return { id, role, label, category: "primary", ...(parentId ? { links: { parentId } } : {}) }; }
function page(snap: ApiMetricsSnapshot | null, entries: ApiComponentManifestEntry[] = [], patch: Partial<ApiDeployment> = {}) {
  vi.mocked(api.getDeployment).mockResolvedValue({ deployment: { ...deployment, ...patch, metricsSnapshot: snap }, latestDeployJob: null, connections: [] });
  vi.mocked(api.getDeploymentBundle).mockResolvedValue({ ...bundle, componentManifest: entries });
  return render(<MantineProvider env="test"><MemoryRouter initialEntries={["/app/deployments/dep_metrics"]}><Routes><Route path="/app/deployments/:id" element={<DeploymentDetail />} /></Routes></MemoryRouter></MantineProvider>);
}
async function metrics() { return within(await screen.findByRole("region", { name: "Pipeline metrics" })); }
function headline(card: ReturnType<typeof within>, label: string) { return card.getByText(label).parentElement!.textContent; }
beforeEach(() => {
  vi.spyOn(api, "getDeployment"); vi.spyOn(api, "getDeploymentBundle");
  vi.spyOn(api, "getDeploymentConfigurationState").mockRejectedValue(new Error("No fixture revision"));
  vi.spyOn(api, "listAllSources").mockResolvedValue({ connections: [], sources: [] });
  vi.spyOn(api, "listMonitors").mockResolvedValue({ monitors: [], sinks: [] });
  vi.spyOn(api, "listDestinations").mockResolvedValue({ destinations: [] });
  vi.spyOn(api, "listDeployTargets").mockResolvedValue({ deployTargets: [] });
});

it.each([null, snapshot({}, { updatedAt: 0 })])("waits for the first metrics delivery without fabricated counters", async snap => {
  page(snap); const card = await metrics(); expect(card.getByText(/Waiting for the first metrics POST/)).toBeTruthy(); expect(card.queryByRole("button", { name: "Rate" })).toBeNull();
});
it.each([null, "none"])("explains how to enable metrics when the target is %s", async target => {
  page(null, [], { metricsTarget: target }); const card = await metrics(); expect(card.getByText(/No metrics target configured/)).toBeTruthy();
});
it("counts each user event once and excludes internal traffic from rates and current-process totals", async () => {
  page(snapshot({
    parent: component("source", 900, 800), alpha: component("transform", 100, 90), beta: component("transform", 50, 30),
    delivery: component("sink", 120, 100, { errors: 5, prev: { sent: 100, errors: 3, sampleAt: now - 60_000 } }),
    filter: component("transform", 150, 100, { received: 150, errors: 999 }),
    internal_metrics: component("source", 50000, 0), metrics_destination: component("sink", 10000, 0, { errors: 999 }),
    legacy_source: component("source", 15, 10), legacy_sink: component("sink", 30, 25, { errors: 1, prev: { sent: 25, errors: 0, sampleAt: now - 60_000 } }),
  }, { lifetimeOffset: { received: 999999, sent: 999999, errors: 999999, discarded: 0 } }), [manifest("parent", "source", "Account"), manifest("alpha", "source", "Worker Alpha", "parent"), manifest("beta", "source", "Worker Beta", "parent"), manifest("delivery", "sink", "Webhook"), manifest("filter", "monitor_filter", "Error filter")]);
  const card = await metrics(); expect(headline(card, "Events received")).toBe("Events received35 /min"); expect(headline(card, "Events sent")).toBe("Events sent25 /min"); expect(headline(card, "Errors")).toBe("Errors3.0 /min");
  fireEvent.click(card.getByRole("button", { name: "Total" }));
  expect(headline(card, "Events received")).toBe("Events received165"); expect(headline(card, "Events sent")).toBe("Events sent150"); expect(headline(card, "Errors")).toBe("Errors6");
  expect(card.getByText("Totals since the current Vector process started.")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Rate" })); expect(headline(card, "Events received")).toBe("Events received35 /min");
});
it("sorts source children by throughput and supports collapsing and reopening their breakdown", async () => {
  page(snapshot({ parent: component("source", 30, 0), alpha: component("transform", 10, 0), beta: component("transform", 20, 0) }), [manifest("parent", "source", "Account"), manifest("alpha", "source", "Worker Alpha", "parent"), manifest("beta", "source", "Worker Beta", "parent")]);
  const card = await metrics(); fireEvent.click(card.getByRole("button", { name: "Show per-component (3)" }));
  const table = card.getByRole("table", { name: "Sources metrics" });
  expect(within(table).getAllByRole("row").map(row => row.textContent)).toEqual([expect.stringContaining("Component"), expect.stringContaining("Account"), expect.stringContaining("Worker Beta"), expect.stringContaining("Worker Alpha")]);
  fireEvent.click(within(table).getByRole("button", { name: "Collapse source breakdown" })); expect(within(table).queryByText("Worker Alpha")).toBeNull();
  fireEvent.click(within(table).getByRole("button", { name: "Expand source breakdown" })); expect(within(table).getByText("Worker Alpha")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Hide per-component" })); expect(card.queryByRole("table")).toBeNull();
});
it("keeps unmatched parent references visible and shows unknown components in optional plumbing", async () => {
  page(snapshot({ orphan: component("source", 10, 5), unknown: component("unknown", 20, 10, { received: 15, prev: { received: 10, sent: 10, sampleAt: now - 60_000 } }) }), [manifest("orphan", "source", "Orphan source", "missing")]);
  const card = await metrics(); fireEvent.click(card.getByRole("button", { name: "Show per-component (2)" }));
  expect(card.getByText("Orphan source")).toBeTruthy(); expect(card.queryByText("unknown · exec")).toBeNull();
  fireEvent.click(card.getByRole("checkbox", { name: "Show plumbing" }));
  const table = card.getByRole("table", { name: "Internal plumbing metrics" }); expect(within(table).getByText("unknown")).toBeTruthy(); expect(within(table).getByText("unknown · exec")).toBeTruthy(); expect(within(table).getByText("5.0/min")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Total" })); expect(within(table).getByText("15")).toBeTruthy();
  fireEvent.click(card.getByRole("checkbox", { name: "Show plumbing" })); expect(card.queryByRole("table", { name: "Internal plumbing metrics" })).toBeNull();
});
it("uses per-counter timestamps rather than another counter's latest observation", async () => {
  page(snapshot({ source: component("source", 20, 10, { sampleAtByField: { sent: now - 30_000 }, prev: { sent: 10, sampleAt: now - 300_000, sampleAtByField: { sent: now - 60_000 } } }) }), [manifest("source", "source", "Timed source")]);
  const card = await metrics(); expect(headline(card, "Events received")).toBe("Events received20 /min");
});
it("shows unavailable first-observation rates and exact counters in the component table", async () => {
  page(snapshot({ source: component("source", 10, 0, { prev: undefined }), sink: component("sink", 0, 0, { sent: undefined, prev: undefined }) }), [manifest("source", "source", "New source"), manifest("sink", "sink", "New sink")]);
  const card = await metrics(); fireEvent.click(card.getByRole("button", { name: "Show per-component (2)" }));
  const sourceRow = card.getByText("New source").closest("tr")!; const sinkRow = card.getByText("New sink").closest("tr")!;
  expect(within(sourceRow).getAllByText("—")).toHaveLength(2);
  fireEvent.click(card.getByRole("button", { name: "Total" })); expect(within(sourceRow).getByText("10")).toBeTruthy(); expect(within(sinkRow).getAllByText("—")).toHaveLength(2);
});
it("renders transform throughput from received counters without adding it to headline log volume", async () => {
  page(snapshot({ filter: component("transform", 999, 900, { received: 30, errors: 0, prev: { received: 20, errors: 0, sampleAt: now - 60_000 } }) }), [manifest("filter", "monitor_filter", "Filter")]);
  const card = await metrics(); expect(headline(card, "Events received")).toBe("Events received0 /min");
  fireEvent.click(card.getByRole("button", { name: "Show per-component (1)" })); fireEvent.click(card.getByRole("checkbox", { name: "Show plumbing" }));
  const row = card.getByText("Filter", { exact: true }).closest("tr")!; expect(within(row).getByText("10/min")).toBeTruthy(); expect(within(row).getByText("0/min")).toBeTruthy();
});
it.each([[0.02, "0.02 /min"], [0.2, "0.2 /min"], [1234, "1,234 /min"]] as const)("formats a %s/min headline for readable rates", async (rate, expected) => {
  page(snapshot({ source: component("source", rate, 0) })); const card = await metrics(); expect(headline(card, "Events received")).toBe(`Events received${expected}`);
});
it("never renders nonfinite rates or totals", async () => {
  page(snapshot({ source: component("source", Infinity, 0), sink: component("sink", NaN, 0, { errors: NaN }) }));
  const card = await metrics(); expect(headline(card, "Events received")).toBe("Events received0 /min");
  fireEvent.click(card.getByRole("button", { name: "Total" })); expect(headline(card, "Events received")).toBe("Events received—"); expect(headline(card, "Events sent")).toBe("Events sent—"); expect(headline(card, "Errors")).toBe("Errors—");
  fireEvent.click(card.getByRole("button", { name: "Show per-component (2)" })); fireEvent.click(card.getByRole("checkbox", { name: "Show plumbing" }));
  expect(card.queryByText(/Infinity|NaN/)).toBeNull();
});
it("shows empty sections and process metadata without inventing pipeline traffic", async () => {
  page(snapshot({}, { vectorVersion: undefined, processStartAt: null })); const card = await metrics();
  expect(card.queryByText(/Vector booted/)).toBeNull(); fireEvent.click(card.getByRole("button", { name: "Show per-component (0)" })); expect(card.getAllByText("(none)")).toHaveLength(2);
});
it("shows the dominant error types first in the delivery tooltip", async () => {
  page(snapshot({ sink: component("sink", 20, 10, { errors: 9, errorsByType: { encoding_failed: 2, request_failed: 7 } }) }), [manifest("sink", "sink", "Failing webhook")]);
  const card = await metrics(); fireEvent.click(card.getByRole("button", { name: "Total" })); fireEvent.click(card.getByRole("button", { name: "Show per-component (1)" }));
  fireEvent.mouseEnter(within(card.getByText("Failing webhook").closest("tr")!).getByText("9"));
  expect((await screen.findByRole("tooltip")).textContent).toBe("request_failed: 7\nencoding_failed: 2");
});
it("marks overflowing aggregate rates unavailable while keeping component observations visible", async () => {
  page(snapshot({ first: component("source", 1e308, 0), second: component("source", 1e308, 0) }));
  const card = await metrics(); expect(headline(card, "Events received")).toBe("Events received— /min");
  fireEvent.click(card.getByRole("button", { name: "Total" })); expect(headline(card, "Events received")).toBe("Events received—");
});
