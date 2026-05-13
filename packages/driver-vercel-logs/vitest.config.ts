import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@logtura/driver-vercel-logs",
    environment: "node",
  },
});
