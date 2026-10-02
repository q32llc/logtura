import { expect, it } from "vitest";
import { validateFilterSteps, type FilterStep } from "../src/index";
it("exposes the same copied filter DSL used by portable graphs", () => {
  const steps: FilterStep[] = [{ kind: "errors" }, { kind: "level", level: "error", mode: "include" }, { kind: "match", pattern: "timeout", mode: "exclude", field: "message" }, { kind: "rate_limit", per_minute: 30 }, { kind: "dedup", window_secs: 60, fields: ["message"] }, { kind: "sample", rate: 5 }, { kind: "rollup", window_secs: 30, group_by: ["site"], max_samples: 4 }];
  const copied = validateFilterSteps(steps);
  expect(copied).toEqual(steps);
  expect(copied).not.toBe(steps);
  expect(copied[4]).not.toBe(steps[4]);
  expect(validateFilterSteps([])).toEqual([]);
});
it.each([null, {}, [{ kind: "unknown" }], [{ kind: "errors", private: "fixture-private-filter" }], [{ kind: "dedup", window_secs: Infinity }], [{ kind: "sample", rate: 0 }]])("rejects invalid public filters without including values (%j)", value => {
  expect(() => validateFilterSteps(value, "monitor filters")).toThrow("monitor filters");
  try { validateFilterSteps(value); } catch (error) { expect(String(error)).not.toContain("fixture-private-filter"); }
});
