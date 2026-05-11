import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@logtura/driver-supabase-edge-logs",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
