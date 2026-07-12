import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: "frontend_v1/ap-resolve-console",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve("frontend_v1/ap-resolve-console/src"),
    },
  },
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
