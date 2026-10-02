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
            // The test-only Wrangler file has a native producer and no consumer.
            // An empty override would merge with (and retain) a configured consumer.
          }),
        ],
        test: {
          name: "workerd",
          // Native logging avoids pending onUserConsoleLog RPCs at DO teardown.
          // Keep diagnostics visible; this does not suppress unhandled errors.
          disableConsoleIntercept: true,
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
        "src/destinations/slack-oauth.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/**/*.{ts,tsx}": { statements: 85, branches: 81.2, functions: 85.7, lines: 83.5 },
        "src/providers/vercel-oauth.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/auth.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/providers/oauth-token.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/providers/oauth-state.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/providers/supabase-oauth.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/providers/railway-oauth.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/providers/tail-token.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },

        "packages/core/src/docker-install.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deploy-targets/other.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deploy-targets/bundle-files.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/runtime-assets.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deploy-targets/fly.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/fly-install.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/oci-image.ts": { statements: 100, branches: 98, functions: 100, lines: 100 },
        "src/forwarder-image.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/jobs/handlers/fly-deploy.ts": { statements: 99, branches: 90, functions: 100, lines: 100 },
        "src/managed-installations.ts": { statements: 96, branches: 95, functions: 100, lines: 100 },
        "src/managed-checkpoints.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/managed-issued-installations.ts": { statements: 97, branches: 97, functions: 100, lines: 100 },
        "src/managed-runtime-inputs.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/managed-runtime-completion.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/managed-runtime-preparation.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/jobs/handlers/fly-checkpoint.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/silence-alerter.ts": { statements: 100, branches: 90, functions: 100, lines: 100 },
        "src/email.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deployment-ingest.ts": { statements: 99, branches: 95, functions: 100, lines: 100 },
        "src/deployment-instances.ts": { statements: 97, branches: 95, functions: 100, lines: 100 },
        "src/deployment-state-routes.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deployment-target.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deployment-push.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deployment-push-receipts.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/credential-intent.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deployment-reconciliation.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deployment-runtime.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deployment-selection.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/deployment-configuration.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/graph-reconciliation.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/config-version.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/cli-auth.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        statements: 91, branches: 88.3, functions: 92.5, lines: 90.2,
        "packages/core/src/reconcile.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/graph.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/provider-connectors.ts": { statements: 100, branches: 97, functions: 100, lines: 100 },
        "packages/cli/src/local-env.ts": { statements: 98, branches: 94, functions: 100, lines: 100 },
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
        "packages/cli/src/fly-apply.ts": { statements: 96, branches: 91, functions: 100, lines: 100 },
        "packages/core/src/runtime-image.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/runtime.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/deployment-state.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/deployment-reporting.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/service-client.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/cli/src/account.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "packages/core/src/config.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "packages/core/src/install.ts": { statements: 100, branches: 95, functions: 100, lines: 100 },
        "packages/core/src/tar.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/driver-railway-logs/src/index.ts": { statements: 100, branches: 99, functions: 100, lines: 100 },
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
