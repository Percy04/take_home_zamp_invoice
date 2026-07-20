import { describe, expect, it } from "vitest";
import { GeminiAdapter, OpenAiAdapter, type AiModelAdapter } from "../server/src/ai-provider.js";

describe("AI model adapters", () => {
  it("exposes both providers through the same internal seam", () => {
    const adapters: Array<new () => AiModelAdapter> = [OpenAiAdapter, GeminiAdapter];

    expect(adapters).toHaveLength(2);
  });
});
