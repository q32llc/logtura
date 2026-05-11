import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workerd-pool integration tests. Real worker with real D1 + Queues,
// migrations applied per-test, only outbound HTTP (Fly GraphQL, etc.)
// mocked. Matches the project's "no DB mocks" rule.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" },
    }),
  ],
  test: {
    name: "workerd",
    include: ["test/workerd/**/*.test.ts"],
    globalSetup: ["./test/workerd/_global-setup.ts"],
    // Istanbul (not v8) because v8 coverage relies on the runtime
    // emitting V8 coverage profile data, which workerd doesn't.
    // Istanbul instruments at the Vite transform step, so it works
    // the same regardless of pool. Enabled only when --coverage is
    // passed; idle otherwise. Run `pnpm test:coverage`.
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/web/**", // SPA; not exercised by workerd tests
        "src/**/*.d.ts",
      ],
    },
  },
});
