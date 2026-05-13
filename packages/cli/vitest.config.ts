import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@logtura/cli",
    include: ["test/**/*.test.ts"],
  },
});
