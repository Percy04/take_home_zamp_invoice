import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeInvoice } from "../server/src/controls.js";
import {
  extractAndMapLive,
  logProviderError,
  ProviderError,
} from "../server/src/providers.js";
import { env } from "../server/src/env.js";

const input = process.argv[2];

if (!input) {
  console.error("Usage: npm run verify:live -- <path-to-invoice.pdf>");
  process.exit(2);
}

try {
  const pdfPath = path.resolve(input);
  console.log("Live provider smoke test");
  console.log(`PDF: ${pdfPath}`);
  console.log(`Azure endpoint: ${redactEndpoint(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT)}`);
  console.log(`Mapping provider: ${env.MAPPING_PROVIDER}`);
  console.log(
    `Mapping model: ${
      env.MAPPING_PROVIDER === "openai" ? env.OPENAI_MODEL : env.GEMINI_MODEL
    }`,
  );

  const result = await extractAndMapLive(await readFile(pdfPath));
  console.log("Provider flow: succeeded");
  console.log(`Evidence count: ${result.evidence.length}`);
  console.log(`Mapped invoice lines: ${result.mapping.lines.length}`);

  const invoice = normalizeInvoice(result.evidence, result.mapping);
  console.log("Normalized invoice summary:");
  console.log(`  Vendor: ${invoice.vendor}`);
  console.log(`  Invoice: ${invoice.invoiceNumber}`);
  console.log(`  PO: ${invoice.poNumber}`);
  console.log(`  Total: ${invoice.currency} ${invoice.total}`);
} catch (caught) {
  logProviderError(caught);
  if (caught instanceof ProviderError) {
    console.error(`Provider stage failed: ${caught.stage}`);
    console.error(JSON.stringify(caught.diagnostics, null, 2));
  }
  process.exitCode = 1;
}

function redactEndpoint(endpoint: string | undefined) {
  if (!endpoint) return "<missing>";
  try {
    return new URL(endpoint).origin;
  } catch {
    return "<invalid-url>";
  }
}
