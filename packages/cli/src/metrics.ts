import { readFileSync } from "node:fs";

interface MetricEvent {
  name?: string;
  namespace?: string;
  tags?: Record<string, string>;
  timestamp?: string | number;
  counter?: { value?: number };
}

interface ComponentStats {
  kind: string;
  type: string;
  received?: number;
  sent?: number;
  errors?: number;
}

export function printStats(path: string): string {
  const events = parseMetrics(readFileSync(path, "utf8"));
  const byComponent = new Map<string, ComponentStats>();
  for (const e of events) {
    if (!e.counter) continue;
    const name = stripNamespace(e.name, e.namespace);
    const field =
      name === "component_received_events_total"
        ? "received"
        : name === "component_sent_events_total"
          ? "sent"
          : name === "component_errors_total"
            ? "errors"
            : null;
    if (!field) continue;
    const id = e.tags?.component_id;
    if (!id) continue;
    const cur =
      byComponent.get(id) ??
      {
        kind: e.tags?.component_kind ?? "unknown",
        type: e.tags?.component_type ?? "unknown",
      };
    cur[field] = e.counter.value ?? 0;
    byComponent.set(id, cur);
  }
  const lines = ["Component\tKind\tType\tReceived\tSent\tErrors"];
  for (const [id, c] of [...byComponent.entries()].sort()) {
    lines.push(
      [
        id,
        c.kind,
        c.type,
        c.received ?? "-",
        c.sent ?? "-",
        c.errors ?? "-",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function parseMetrics(text: string): MetricEvent[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as MetricEvent[];
  if (trimmed.startsWith("{")) return [JSON.parse(trimmed) as MetricEvent];
  return trimmed
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as MetricEvent);
}

function stripNamespace(name: unknown, namespace: unknown): string | null {
  if (typeof name !== "string") return null;
  if (typeof namespace === "string" && name.startsWith(`${namespace}_`)) {
    return name.slice(namespace.length + 1);
  }
  if (name.startsWith("vector_")) return name.slice("vector_".length);
  return name;
}
