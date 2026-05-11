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
  },
});
