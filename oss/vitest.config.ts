import { defineConfig } from "vitest/config";

/**
 * Root vitest config for the public @logtura/* monorepo. Fans into
 * every package's own vitest config via `test.projects`. The hosted
 * product has additional workerd-based integration tests that don't
 * live in this repo.
 */
export default defineConfig({
  test: {
    projects: [
      "./packages/core",
      "./packages/destination-datadog-metrics",
      "./packages/destination-prometheus-remote-write",
      "./packages/destination-slack",
      "./packages/destination-webhook",
      "./packages/driver-cloudflare-ai-gateway",
      "./packages/driver-cloudflare-worker-tail",
      "./packages/driver-fly-log-tail",
      "./packages/driver-supabase-edge-logs",
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
