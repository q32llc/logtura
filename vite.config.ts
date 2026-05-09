import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
