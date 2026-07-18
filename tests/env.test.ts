import { describe, expect, it } from "vitest";
import { parseEnv } from "../server/src/env.js";

describe("production provider configuration", () => {
  it("requires live providers in production", () => {
    expect(() => parseEnv({ NODE_ENV: "production", PROVIDER_MODE: "recorded" })).toThrow(/PROVIDER_MODE=live/);
  });

  it("keeps recorded mode available to tests", () => {
    expect(parseEnv({ NODE_ENV: "test", PROVIDER_MODE: "recorded" }).PROVIDER_MODE).toBe("recorded");
  });
});
