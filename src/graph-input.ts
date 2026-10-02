import { validateFilterSteps, type FilterStep } from "@logtura/core";

export class GraphInputError extends Error {
  constructor(readonly code: "invalid_form" | "missing_fields" | "missing_destination" = "invalid_form") {
    super(code);
  }
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new GraphInputError();
  return value as Record<string, unknown>;
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new GraphInputError();
  return value;
}
function filters(value: unknown): FilterStep[] {
  try { return validateFilterSteps(value); } catch { throw new GraphInputError(); }
}
export interface MonitorMutation {
  displayName?: string;
  connectionId?: string | null;
  enabled?: boolean;
  filterSteps?: FilterStep[];
}
export function parseMonitorMutation(value: unknown, create: boolean): MonitorMutation {
  const row = object(value, ["displayName", "connectionId", "enabled", "filterSteps"]);
  if (create && row.displayName === undefined) throw new GraphInputError("missing_fields");
  const result: MonitorMutation = {};
  if (row.displayName !== undefined) result.displayName = name(row.displayName);
  if (row.connectionId !== undefined) result.connectionId = row.connectionId === null ? null : name(row.connectionId);
  if (row.enabled !== undefined) {
    if (typeof row.enabled !== "boolean") throw new GraphInputError();
    result.enabled = row.enabled;
  }
  if (row.filterSteps !== undefined) result.filterSteps = filters(row.filterSteps);
  return result;
}
export function parseSinkMutation(value: unknown, create: boolean): { destinationId?: string; filterSteps?: FilterStep[] } {
  const row = object(value, create ? ["destinationId", "filterSteps"] : ["filterSteps"]);
  const result: { destinationId?: string; filterSteps?: FilterStep[] } = {};
  if (create) {
    if (row.destinationId === undefined) throw new GraphInputError("missing_destination");
    result.destinationId = name(row.destinationId);
  }
  if (row.filterSteps !== undefined) result.filterSteps = filters(row.filterSteps);
  return result;
}
