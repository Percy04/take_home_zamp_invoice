import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve("client/src"),
      react: path.resolve("node_modules/react"),
      "react-dom": path.resolve("node_modules/react-dom"),
    },
    dedupe: ["react", "react-dom"],
  },
  test: { include: ["tests/**/*.test.{ts,tsx}"] },
});
