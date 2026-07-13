import { describe, expect, it } from "vitest";
import path from "node:path";
import config from "../vite.config.js";

describe("Vite React resolution", () => {
  it("uses the root React runtime for the nested frontend", () => {
    const resolve = config.resolve!;

    expect(resolve.dedupe).toEqual(["react", "react-dom"]);
    expect(resolve.alias).toMatchObject({
      react: path.resolve("node_modules/react"),
      "react-dom": path.resolve("node_modules/react-dom"),
    });
  });
});
