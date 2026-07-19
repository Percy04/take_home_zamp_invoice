import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/src/app.js";
import { parseEnv } from "../server/src/env.js";
import { Storage } from "../server/src/storage.js";
import { recordedInvoiceExtractor } from "./support/recorded-invoice-extractor.js";

describe("provider configuration", () => {
  it("requires Azure credentials outside tests", () => {
    expect(() => parseEnv({ NODE_ENV: "production", MAPPING_PROVIDER: "openai", OPENAI_API_KEY: "key" })).toThrow(
      /AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT/,
    );
  });

  it("requires the selected mapper key outside tests", () => {
    expect(() => parseEnv({ NODE_ENV: "staging", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.com", AZURE_DOCUMENT_INTELLIGENCE_KEY: "key" })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it("allows test startup without credentials only with an injected extractor", () => {
    expect(parseEnv({ NODE_ENV: "test" })).toMatchObject({ NODE_ENV: "test" });
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-test-extractor-"));
    const storage = new Storage(runtime);
    try {
      expect(() => createApp({ storage })).toThrow("TEST_EXTRACTOR_REQUIRED");
      expect(() => createApp({ storage, extractInvoice: recordedInvoiceExtractor })).not.toThrow();
    } finally {
      storage.close();
      rmSync(runtime, { recursive: true });
    }
  });
});
