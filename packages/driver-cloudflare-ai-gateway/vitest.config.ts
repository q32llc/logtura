import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@logtura/driver-cloudflare-ai-gateway",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
