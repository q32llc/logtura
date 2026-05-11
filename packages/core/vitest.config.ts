import { defineConfig } from "vitest/config";

// Pure-logic tests for @logtura/core. Node env, no workerd —
// the renderer is a pure function (structured input → structured
// output), so tests should run in <1s without bringing up D1,
// Queues, or any worker runtime.
export default defineConfig({
  test: {
    name: "@logtura/core",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
