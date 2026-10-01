import { defineConfig } from "vitest/config";

/**
 * Root vitest config for the public @logtura/* monorepo. Fans into
 * every package's own vitest config via `test.projects`.
 */
export default defineConfig({
  test: {
    projects: [
      "./packages/core",
      "./packages/cli",
      "./packages/custom-vector",
      "./packages/destination-datadog-metrics",
      "./packages/destination-prometheus-remote-write",
      "./packages/destination-slack",
      "./packages/destination-webhook",
      "./packages/driver-cloudflare-ai-gateway",
      "./packages/driver-cloudflare-worker-tail",
      "./packages/driver-fly-log-tail",
      "./packages/driver-supabase-edge-logs",
      "./packages/driver-vercel-logs",
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html", "lcov", "json-summary"],
      // Initial measured floor; the convergence plan requires 95/90 targets.
      thresholds: { statements: 55, branches: 43, functions: 57, lines: 58 },
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
