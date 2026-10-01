import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "@logtura/supabase-shared", environment: "node", include: ["test/**/*.test.ts"] } });
