import { readFile } from "node:fs/promises";
import path from "node:path";
import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from "@azure-rest/ai-document-intelligence";
import { PDFDocument } from "pdf-lib";
import { sourceRefSchema, type AiRecheck, type SourceRef } from "../../shared/contracts.js";
import { configuredAiAdapter } from "./ai-provider.js";
import { recheckLowConfidenceFields, recheckMissingFieldsWithFullDocument, type LowConfidenceField } from "./ai-rechecks.js";
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

export async function extractAndMap(bytes: Buffer): Promise<InvoiceExtractorResult> {
  return env.PROVIDER_MODE === "live" ? extractAndMapLive(bytes) : extractAndMapRecorded(bytes);
}

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

async function extractAndMapRecorded(bytes: Buffer): Promise<{
  evidence: SourceRef[];
  mapping: InvoiceMapping;
  originalMapping: InvoiceMapping;
  aiRechecks: AiRecheck[];
}> {
  const recording = await recordingForDocument(bytes);
  const evidence = await recordedEvidence(recording);
  const mapping: InvoiceMapping = {
    vendor: "case.vendor",
    invoiceNumber: "case.invoiceNumber",
    invoiceDate: "case.invoiceDate",
    poNumber: "case.poNumber",
    currency: "case.currency",
    subtotal: hasSource(evidence, "case.subtotal") ? "case.subtotal" : null,
    tax: hasSource(evidence, "case.tax") ? "case.tax" : null,
    total: "case.total",
    taxNote: hasSource(evidence, "case.taxNote") ? "case.taxNote" : null,
    lines: recordedLineIndexes(evidence).map((index) => ({
      sku: `case.lines.${index}.sku`,
      description: `case.lines.${index}.description`,
      quantity: `case.lines.${index}.quantity`,
      uom: `case.lines.${index}.uom`,
      unitPrice: `case.lines.${index}.unitPrice`,
      amount: `case.lines.${index}.amount`,
    })),
  };
  if (recording === "happy_layout_c_scanned") {
    mapping.poNumber = "field.PurchaseOrder";
    mapping.lines = mapping.lines.map((line, index) => ({ ...line, sku: `item.${index}.ProductCode`, quantity: `item.${index}.Quantity` }));
  }
  validateMapping(mapping, evidence);
  return recording === "happy_layout_c_scanned"
    ? recheckLowConfidenceFields(bytes, evidence, mapping, async (_page, fields) => recordedRecheckValues(fields), "recorded-fixture")
    : { evidence, mapping, originalMapping: mapping, aiRechecks: [] };
}

function recordedRecheckValues(fields: LowConfidenceField[]) {
  const values: Record<string, string> = {
    poNumber: "PO-1001",
    "lines.0.sku": "WID-100",
    "lines.0.quantity": "8",
    "lines.1.quantity": "5",
  };
  return Object.fromEntries(fields.map((field) => [field.field, values[field.field] ?? null]));
}

async function recordingForDocument(bytes: Buffer) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  const title = pdf.getTitle();
  const scannedFixture =
    title === "untitled" &&
    pdf.getAuthor() === "anonymous" &&
    pdf.getCreator() === "anonymous" &&
    pdf.getPage(0).node.Resources()?.toString().includes("/FormXob.59434872ae9880c0340555aef842a3a5");
  // ponytail: the committed scan has no title; this exact embedded-image marker keeps
  // recorded mode deterministic without treating arbitrary untitled PDFs as ACME.
  if (scannedFixture) return "happy_layout_c_scanned";
  if (title === "Invoice ACME-2026-001") return "happy";
  if (title === "Invoice ACME-2026-000") return "duplicate";
  if (title === "Invoice DELTA-2026-010") return "receipt_capacity";
  if (title === "Invoice DELTA-2026-011") return "multiple_issues";
  if (title === "Invoice ACME-2026-003") return "bundle_known";
  if (title === "Invoice ACME-2026-005") return "tax_inclusive";
  if (title === "Invoice ACME-2026-002") return "missing_po";
  if (title === "Invoice ACME-2026-006") return "missing_po_bundle";
  if (title === "Invoice ACME-2026-004") return "bundle_unknown";
  throw new ProviderError("RECORDED_PROVIDER", "No recorded provider response for this document.");
}

async function recordedEvidence(recording: string) {
  const sourcesPath = path.resolve(`data/recordings/${recording}_sources.json`);
  let evidence: SourceRef[] = [];
  try {
    evidence = sourceRefSchema.array().parse(JSON.parse(await readFile(sourcesPath, "utf8")) as unknown);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw caught;
  }
  const cases = JSON.parse(await readFile(path.resolve("data/cases.json"), "utf8")) as {
    fixtures: Record<string, { input: RecordedInput }>;
  };
  const input = cases.fixtures[recording]?.input;
  if (!input) throw new ProviderError("RECORDED_PROVIDER", "Unknown fixture.");
  const caseRefs: SourceRef[] = [
    ref("case.vendor", "VendorName", input.vendor),
    ref("case.invoiceNumber", "InvoiceId", input.invoice_number),
    ref("case.invoiceDate", "InvoiceDate", input.invoice_date),
    ref("case.poNumber", "PurchaseOrder", input.po_number ?? ""),
    ref("case.currency", "Currency", input.currency),
    ref("case.total", "InvoiceTotal", input.total),
    ...(input.subtotal ? [ref("case.subtotal", "SubTotal", input.subtotal)] : []),
    ...(input.tax ? [ref("case.tax", "TotalTax", input.tax)] : []),
    ...(input.tax_note ? [ref("case.taxNote", "TaxNote", input.tax_note)] : []),
    ...input.lines.flatMap((line, index) => [
      ref(`case.lines.${index}.sku`, "ProductCode", line.sku),
      ref(`case.lines.${index}.description`, "Description", line.description),
      ref(`case.lines.${index}.quantity`, "Quantity", line.quantity),
      ref(`case.lines.${index}.uom`, "Unit", line.uom),
      ref(`case.lines.${index}.unitPrice`, "UnitPrice", line.unit_price),
      ref(`case.lines.${index}.amount`, "Amount", line.amount),
    ]),
  ];
  return sourceRefSchema.array().parse([...evidence, ...caseRefs]);
}

type RecordedInput = {
  vendor: string;
  invoice_number: string;
  invoice_date: string;
  po_number: string | null;
  currency: string;
  subtotal: string | null;
  tax: string | null;
  total: string;
  tax_note?: string;
  lines: Array<{ sku: string; description: string; quantity: string; uom: string; unit_price: string; amount: string }>;
};

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

function ref(id: string, label: string, content: string): SourceRef {
  return { id, label, content, confidence: 1, page: 1 };
}

function hasSource(evidence: SourceRef[], id: string) {
  return evidence.some((source) => source.id === id);
}

function recordedLineIndexes(evidence: SourceRef[]) {
  return [...new Set(evidence.map((source) => source.id.match(/^case\.lines\.(\d+)\./)?.[1]).filter(Boolean).map(Number))].sort(
    (left, right) => left - right,
  );
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
