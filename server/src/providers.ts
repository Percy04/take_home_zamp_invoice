import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from "@azure-rest/ai-document-intelligence";
import { sourceRefSchema, type AiRecheck, type SourceRef } from "../../shared/contracts.js";
import { configuredAiAdapter } from "./ai-provider.js";
import { recheckLowConfidenceFields, recheckMissingFieldsWithFullDocument } from "./ai-rechecks.js";
import { env } from "./env.js";
import { emptyInvoiceMapping, validateMapping, type InvoiceMapping } from "./invoice-mapping.js";
import { ProviderError, providerError, safeError, withOneMappingRetry } from "./provider-errors.js";

type AzureField = {
  content?: string;
  confidence?: number;
  boundingRegions?: Array<{ pageNumber?: number }>;
  spans?: Array<{ offset: number; length: number }>;
  valueArray?: Array<{ valueObject?: Record<string, AzureField> }>;
  valueObject?: Record<string, AzureField>;
};
type AzureResult = {
  status?: string;
  analyzeResult?: {
    documents?: Array<{ fields?: Record<string, AzureField> }>;
    pages?: Array<{
      pageNumber: number;
      lines?: Array<{ content?: string; spans?: Array<{ offset: number; length: number }> }>;
      words?: Array<{ confidence: number; span: { offset: number; length: number } }>;
    }>;
    tables?: Array<{
      cells: Array<{
        content: string;
        rowIndex: number;
        columnIndex: number;
        boundingRegions?: Array<{ pageNumber?: number }>;
      }>;
    }>;
    keyValuePairs?: Array<{
      confidence: number;
      key: { content: string; boundingRegions?: Array<{ pageNumber?: number }> };
      value?: { content: string; boundingRegions?: Array<{ pageNumber?: number }> };
    }>;
  };
};

export type InvoiceExtractorResult = {
  evidence: SourceRef[];
  mapping: InvoiceMapping;
  originalMapping: InvoiceMapping;
  aiRechecks: AiRecheck[];
};

export type InvoiceExtractor = (bytes: Buffer) => Promise<InvoiceExtractorResult>;

export const extractAndMap: InvoiceExtractor = extractAndMapLive;

export async function extractAndMapLive(bytes: Buffer): Promise<InvoiceExtractorResult> {
  const missing = [
    env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ? null : "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
    env.AZURE_DOCUMENT_INTELLIGENCE_KEY ? null : "AZURE_DOCUMENT_INTELLIGENCE_KEY",
    env.MAPPING_PROVIDER === "openai" && !env.OPENAI_API_KEY ? "OPENAI_API_KEY" : null,
    env.MAPPING_PROVIDER === "gemini" && !env.GEMINI_API_KEY ? "GEMINI_API_KEY" : null,
  ].filter(Boolean);

  if (
    !env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ||
    !env.AZURE_DOCUMENT_INTELLIGENCE_KEY ||
    (env.MAPPING_PROVIDER === "openai" ? !env.OPENAI_API_KEY : !env.GEMINI_API_KEY)
  ) {
    throw new ProviderError("CONFIG", "Live providers are not configured.", { missing: missing.join(", ") });
  }

  const adapter = configuredAiAdapter();
  const client = DocumentIntelligence(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT, { key: env.AZURE_DOCUMENT_INTELLIGENCE_KEY });
  let result: AzureResult;

  try {
    const initial = await client.path("/documentModels/{modelId}:analyze", "prebuilt-invoice").post({
      contentType: "application/json",
      body: { base64Source: bytes.toString("base64") },
      queryParameters: { features: ["keyValuePairs"] },
      abortSignal: AbortSignal.timeout(60_000),
    });

    if (isUnexpected(initial)) throw new ProviderError("AZURE_ANALYZE", "Azure analyze request failed.", { status: initial.status });

    const poller = getLongRunningPoller(client, initial);

    result = (await withTimeout(poller.pollUntilDone(), 60_000, "Azure extraction timed out.")).body as unknown as AzureResult;
  } catch (caught) {
    if (caught instanceof ProviderError) throw caught;
    throw providerError("AZURE_ANALYZE", "Azure analyze request failed.", caught);
  }
  if (result.status !== "succeeded") throw new ProviderError("AZURE_RESULT", "Azure extraction failed.", { status: result.status ?? "unknown" });

  const evidence = buildSourceCatalogue(result, true);
  if (!evidence.length)
    return recheckMissingFieldsWithFullDocument(bytes, evidence, emptyInvoiceMapping(), adapter.readDocument.bind(adapter), adapter.model);

  const mapping = await withOneMappingRetry(async () => {
    const resultMapping = await adapter.mapEvidence(evidence);
    validateMapping(resultMapping, evidence);
    return resultMapping;
  });

  const reread = await recheckLowConfidenceFields(bytes, evidence, mapping, adapter.readPage.bind(adapter), adapter.model);

  const fullDocument = await recheckMissingFieldsWithFullDocument(
    bytes,
    reread.evidence,
    reread.mapping,
    adapter.readDocument.bind(adapter),
    adapter.model,
  );

  return {
    ...fullDocument,
    originalMapping: mapping,
    aiRechecks: [...reread.aiRechecks, ...fullDocument.aiRechecks],
  };
}

export function buildSourceCatalogue(payload: AzureResult, allowEmpty = false): SourceRef[] {
  const result = payload.analyzeResult;
  const fields = result?.documents?.[0]?.fields ?? {};
  const evidence: SourceRef[] = [];
  const add = (id: string, label: string, field: AzureField, sourceKind: SourceRef["sourceKind"]) => {
    if (!field.content) return;
    evidence.push({
      id,
      content: field.content,
      confidence: field.confidence ?? null,
      page: field.boundingRegions?.[0]?.pageNumber ?? null,
      label,
      sourceKind,
    });
  };
  for (const [label, field] of Object.entries(fields)) {
    if (label === "Items") {
      for (const [index, item] of (field.valueArray ?? []).entries())
        for (const [childLabel, child] of Object.entries(item.valueObject ?? {})) add(`item.${index}.${childLabel}`, childLabel, child, "ITEM");
    } else if (/tax/i.test(label) && field.valueArray?.length) {
      for (const [index, item] of field.valueArray.entries())
        for (const [childLabel, child] of Object.entries(item.valueObject ?? {})) add(`tax.${index}.${childLabel}`, childLabel, child, "TAX");
    } else {
      add(`field.${label}`, label, field, "FIELD");
    }
  }
  for (const [tableIndex, table] of (result?.tables ?? []).entries()) {
    for (const cell of table.cells) {
      if (!cell.content) continue;
      evidence.push({
        id: `table.${tableIndex}.r${cell.rowIndex}.c${cell.columnIndex}`,
        content: cell.content,
        confidence: null,
        page: cell.boundingRegions?.[0]?.pageNumber ?? null,
        label: "Table cell",
        sourceKind: "TABLE",
        tableIndex,
        row: cell.rowIndex,
        column: cell.columnIndex,
      });
    }
  }
  for (const page of result?.pages ?? []) {
    for (const [index, line] of (page.lines ?? []).entries()) {
      if (!line.content) continue;
      const overlappingWords = (page.words ?? []).filter((word) => line.spans?.some((span) => spansOverlap(span, word.span)));
      evidence.push({
        id: `line.${page.pageNumber}.l${index}`,
        content: line.content,
        confidence: overlappingWords.length ? Math.min(...overlappingWords.map((word) => word.confidence)) : null,
        page: page.pageNumber,
        label: "OCR line",
        sourceKind: "OCR_LINE",
        lineIndex: index,
      });
    }
  }
  for (const [index, pair] of (result?.keyValuePairs ?? []).entries()) {
    for (const [part, element] of [["key", pair.key], ["value", pair.value]] as const) {
      if (!element?.content) continue;
      evidence.push({
        id: `key_value.${index}.${part}`,
        content: element.content,
        confidence: pair.confidence,
        page: element.boundingRegions?.[0]?.pageNumber ?? null,
        label: part === "key" ? "Key-value key" : "Key-value value",
        sourceKind: "KEY_VALUE",
      });
    }
  }
  if (!evidence.length && !allowEmpty) throw new ProviderError("AZURE_EVIDENCE", "Azure returned no usable invoice evidence.");
  return sourceRefSchema.array().parse(evidence);
}

export function logProviderError(error: unknown) {
  if (error instanceof ProviderError) {
    console.error("[provider]", error.stage, error.message, error.diagnostics);
    return;
  }
  console.error("[provider] UNKNOWN", safeError(error));
}

export function providerFailureReason(error: unknown) {
  return error instanceof ProviderError && ["OPENAI_MAPPING", "GEMINI_MAPPING", "MAPPING_VALIDATION"].includes(error.stage)
    ? "MAPPING_FAILED"
    : "EXTRACTION_FAILED";
}

function spansOverlap(left: { offset: number; length: number }, right: { offset: number; length: number }) {
  return left.offset < right.offset + right.length && right.offset < left.offset + left.length;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
