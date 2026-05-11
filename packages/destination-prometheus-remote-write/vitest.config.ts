import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@logtura/destination-prometheus-remote-write",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
