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
      react: path.resolve("node_modules/react"),
      "react-dom": path.resolve("node_modules/react-dom"),
    },
    dedupe: ["react", "react-dom"],
  },
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: {
    fs: { allow: [path.resolve(".")] },
    proxy: { "/api": "http://localhost:3000" },
  },
});
