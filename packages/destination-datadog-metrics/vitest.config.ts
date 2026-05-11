import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@logtura/destination-datadog-metrics",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
