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
      "./packages/cloudflare-shared",
      "./packages/supabase-shared",
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
      thresholds: {
        statements: 76, branches: 71, functions: 76, lines: 76,
        "packages/core/src/graph.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/graph.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/manifest.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/json.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/pull.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/service-client.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "packages/cli/src/account.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "packages/core/src/config.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "packages/core/src/install.ts": { statements: 100, branches: 95, functions: 100, lines: 100 },
        "packages/core/src/tar.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cloudflare-shared/src/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/supabase-shared/src/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
