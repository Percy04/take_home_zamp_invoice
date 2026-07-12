import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve("frontend_v1/ap-resolve-console/src") },
  },
  test: { include: ["tests/**/*.test.{ts,tsx}"] },
});
