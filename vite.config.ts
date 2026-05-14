import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";

export default defineConfig({
  plugins: [mdx({ providerImportSource: "@mdx-js/react" }), react()],
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/login": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/logout": "http://localhost:8787",
    },
  },
});
