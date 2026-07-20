import { describe, expect, it } from "vitest";
import { ProviderError, withOneMappingRetry } from "../server/src/provider-errors.js";

describe("mapping retry", () => {
  it("retries a transient or malformed mapping once", async () => {
    let calls = 0;
    await expect(
      withOneMappingRetry(async () => {
        calls += 1;
        if (calls === 1) throw new ProviderError("OPENAI_MAPPING", "malformed", { malformed: true });
        return "mapped";
      }),
    ).resolves.toBe("mapped");
    expect(calls).toBe(2);
  });

  it("does not retry permanent authentication failures", async () => {
    let calls = 0;
    await expect(
      withOneMappingRetry(async () => {
        calls += 1;
        throw new ProviderError("GEMINI_MAPPING", "unauthorized", { status: 401 });
      }),
    ).rejects.toThrow("unauthorized");
    expect(calls).toBe(1);
  });
});
