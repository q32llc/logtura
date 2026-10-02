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
        statements: 87, branches: 85, functions: 85, lines: 85,
        "packages/core/src/reconcile.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/graph.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/graph.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/manifest.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/json.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/pull.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/file-transaction.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/deployment-target.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/fly-target.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/deployment-link.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/activation.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/push.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/runtime-process.ts": { statements: 98, branches: 92, functions: 100, lines: 100 },
        "packages/cli/src/runtime-main.ts": { statements: 100, branches: 92, functions: 100, lines: 100 },
        "packages/cli/src/runtime-report.ts": { statements: 97, branches: 95, functions: 100, lines: 100 },
        "packages/cli/src/private-lock.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/push-lock.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/metrics.ts": { statements: 99, branches: 95, functions: 100, lines: 100 },
        "packages/cli/src/metrics.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/fly.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/fly-runtime.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/fly-apply.ts": { statements: 95, branches: 90, functions: 100, lines: 100 },
        "packages/core/src/runtime-image.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/runtime.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/deployment-state.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/deployment-reporting.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/service-client.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
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
