import { defineConfig } from "vite";

// Served from https://zldqms6.github.io/mm-sla-app/ (GitHub Pages project site).
export default defineConfig({
  base: "/mm-sla-app/",
  build: { target: "es2020", chunkSizeWarningLimit: 1500 },
});
