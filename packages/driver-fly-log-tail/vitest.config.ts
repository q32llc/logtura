import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@logtura/driver-fly-log-tail",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
