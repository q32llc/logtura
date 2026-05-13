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
            wrangler: { configPath: "./wrangler.test.toml" },
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
      "./packages/destination-datadog-metrics",
      "./packages/destination-prometheus-remote-write",
      "./packages/destination-slack",
      "./packages/destination-webhook",
      "./packages/driver-cloudflare-ai-gateway",
      "./packages/driver-cloudflare-worker-tail",
      "./packages/driver-fly-log-tail",
      "./packages/driver-railway-logs",
      "./packages/driver-supabase-edge-logs",
    ],
    // Coverage rolls up across projects. Istanbul because workerd
    // doesn't emit V8 profile data; istanbul instruments via the
    // Vite transform step and works regardless of pool.
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
      exclude: [
        "src/web/**",
        "**/*.d.ts",
      ],
    },
  },
});
