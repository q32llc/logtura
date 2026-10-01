import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Root vitest config — fans into two projects so `pnpm test` runs
// the whole tree in one command:
//
//   workerd        — SaaS-side integration tests in test/workerd/.
//                    Real D1 + Queues + signed sessions, only
//                    outbound HTTP (Fly GraphQL, CF API, …) mocked.
//   @logtura/core  — pure-logic tests in packages/core/test/.
//                    Plain inputs, no I/O, sub-second. Vitest picks
//                    up the package's local config via the path.
//
// Run a single project: `vitest run --project workerd` or
// `vitest run --project @logtura/core`.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.test.toml", environment: "test" },
          }),
        ],
        test: {
          name: "workerd",
          include: ["test/workerd/**/*.test.ts"],
          globalSetup: ["./test/workerd/_global-setup.ts"],
        },
      },
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
      "./packages/driver-railway-logs",
      "./packages/driver-supabase-edge-logs",
      "./packages/driver-vercel-logs",
    ],
    // Coverage rolls up across projects. Istanbul because workerd
    // doesn't emit V8 profile data; istanbul instruments via the
    // Vite transform step and works regardless of pool.
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html", "lcov", "json-summary"],
      // Baseline floor; raise these as the planned coverage slices land.
      // Final scope targets are 95% lines/statements/functions and 90% branches.
      thresholds: {
        "src/config-version.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/cli-auth.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        statements: 67, branches: 58, functions: 71, lines: 67,
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
      include: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
      exclude: [
        "src/web/**",
        "**/*.d.ts",
      ],
    },
  },
});
