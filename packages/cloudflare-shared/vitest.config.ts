import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "@logtura/cloudflare-shared", environment: "node", include: ["test/**/*.test.ts"] } });
