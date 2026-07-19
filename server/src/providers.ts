import { readFile } from "node:fs/promises";
import path from "node:path";
import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from "@azure-rest/ai-document-intelligence";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { sourceRefSchema, type AiRecheck, type SourceRef } from "../../shared/contracts.js";
import { env } from "./env.js";
import {
  completeInvoiceExtraction,
  emptyInvoiceMapping,
  extractedValueFields,
  fullDocumentTargets,
  fullInvoiceExtractionSchema,
  fullInvoiceJsonSchema,
  invoiceMappingJsonSchemaForEvidence,
  invoiceMappingSchema,
  invoiceMappingSchemaForEvidence,
  lowConfidenceMappedFields,
  mappingHeaderFields,
  mappingLineFields,
  mergeFullDocumentMapping,
  needsFullDocumentFallback,
  preferReliableEvidence,
  replaceMappedEvidence,
  restoreRecheckedMapping,
  validateMapping,
  type InvoiceExtraction,
  type InvoiceMapping,
} from "./invoice-mapping.js";
import { ProviderError, providerError, safeError, safeResponseError, withOneMappingRetry } from "./provider-errors.js";

export {
  invoiceMappingSchema,
  invoiceMappingSchemaForEvidence,
  preferReliableEvidence,
  restoreRecheckedMapping,
  validateMapping,
  ProviderError,
  withOneMappingRetry,
};
export type { InvoiceExtraction, InvoiceMapping };

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
      lines?: Array<{
        content?: string;
        spans?: Array<{ offset: number; length: number }>;
      }>;
      words?: Array<{
        confidence: number;
        span: { offset: number; length: number };
      }>;
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
      key: {
        content: string;
        boundingRegions?: Array<{ pageNumber?: number }>;
      };
      value?: {
        content: string;
        boundingRegions?: Array<{ pageNumber?: number }>;
      };
    }>;
  };
};

export async function extractAndMap(bytes: Buffer): Promise<{
  evidence: SourceRef[];
  mapping: InvoiceMapping;
  originalMapping: InvoiceMapping;
  aiRechecks: AiRecheck[];
}> {
  return env.PROVIDER_MODE === "live" ? extractAndMapLive(bytes) : extractAndMapRecorded(bytes);
}

export async function extractAndMapLive(bytes: Buffer) {
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
    throw new ProviderError("CONFIG", "Live providers are not configured.", {
      missing: missing.join(", "),
    });
  }
  const client = DocumentIntelligence(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT, { key: env.AZURE_DOCUMENT_INTELLIGENCE_KEY });
  let result: AzureResult;
  try {
    const initial = await client.path("/documentModels/{modelId}:analyze", "prebuilt-invoice").post({
      contentType: "application/json",
      body: { base64Source: bytes.toString("base64") },
      queryParameters: { features: ["keyValuePairs"] },
      abortSignal: AbortSignal.timeout(60_000),
    });
    if (isUnexpected(initial))
      throw new ProviderError("AZURE_ANALYZE", "Azure analyze request failed.", {
        status: initial.status,
      });
    const poller = getLongRunningPoller(client, initial);
    result = (await withTimeout(poller.pollUntilDone(), 60_000, "Azure extraction timed out.")).body as unknown as AzureResult;
  } catch (caught) {
    if (caught instanceof ProviderError) throw caught;
    throw providerError("AZURE_ANALYZE", "Azure analyze request failed.", caught);
  }
  if (result.status !== "succeeded")
    throw new ProviderError("AZURE_RESULT", "Azure extraction failed.", {
      status: result.status ?? "unknown",
    });
  const evidence = buildSourceCatalogue(result, true);
  if (!evidence.length) return recheckMissingFieldsWithFullDocument(bytes, evidence, emptyInvoiceMapping());
  const mapping = await mapEvidenceWithRetry(evidence);
  const reread = await recheckLowConfidenceFields(bytes, evidence, mapping);
  const fullDocument = await recheckMissingFieldsWithFullDocument(bytes, reread.evidence, reread.mapping);
  return {
    ...fullDocument,
    originalMapping: mapping,
    aiRechecks: [...reread.aiRechecks, ...fullDocument.aiRechecks],
  };
}

type LowConfidenceField = {
  field: string;
  source: SourceRef;
};

type AiPageReader = (pagePdf: Buffer, fields: LowConfidenceField[]) => Promise<Record<string, string | null>>;

type AiFullDocumentReader = (documentPdf: Buffer) => Promise<unknown>;

function aiRecheckResponseSchemaFor(fields: LowConfidenceField[]) {
  return z.object({
    values: z.object(Object.fromEntries(fields.map((field) => [field.field, z.string().nullable()]))),
  });
}

/** Re-read each affected PDF page once; the response can only replace extraction values. */
export async function recheckLowConfidenceFields(
  bytes: Buffer,
  evidence: SourceRef[],
  mapping: InvoiceMapping,
  readPage: AiPageReader = readPageWithConfiguredAi,
  model = configuredModel(),
): Promise<{
  evidence: SourceRef[];
  mapping: InvoiceMapping;
  originalMapping: InvoiceMapping;
  aiRechecks: AiRecheck[];
}> {
  const fields = lowConfidenceMappedFields(evidence, mapping);
  if (!fields.length) return { evidence, mapping, originalMapping: mapping, aiRechecks: [] };

  const rechecks: AiRecheck[] = [];
  const replacements = new Map<string, string>();
  const answeredFields = new Set<string>();
  const byPage = new Map<number, LowConfidenceField[]>();
  for (const field of fields) {
    if (!field.source.page) {
      rechecks.push(recheckRecord(field, null, "needs_review", model));
      continue;
    }
    const pageFields = byPage.get(field.source.page) ?? [];
    pageFields.push(field);
    byPage.set(field.source.page, pageFields);
  }

  for (const [page, pageFields] of byPage) {
    let values: Record<string, string | null> | null = null;
    try {
      values = await readPage(await singlePagePdf(bytes, page), pageFields);
    } catch {
      // One attempt per page group: retain the OCR selection for human review.
    }
    for (const field of pageFields) {
      const answered = values !== null && Object.hasOwn(values, field.field);
      const value = values?.[field.field]?.trim() || null;
      const outcome = value ? "resolved" : "needs_review";
      rechecks.push(recheckRecord(field, value, outcome, model));
      const id = `ai_recheck.${field.field}`;
      if (answered) {
        answeredFields.add(field.field);
        replacements.set(field.field, id);
      }
    }
  }

  const aiEvidence = rechecks.flatMap((recheck) =>
    answeredFields.has(recheck.field)
      ? [
          {
            id: `ai_recheck.${recheck.field}`,
            content: recheck.aiValue ?? "",
            confidence: null,
            page: recheck.page,
            label: `${formatRecheckField(recheck.field)} AI re-read`,
            sourceKind: "AI_RECHECK" as const,
          },
        ]
      : [],
  );
  return {
    evidence: sourceRefSchema.array().parse([...evidence, ...aiEvidence]),
    mapping: replaceMappedEvidence(mapping, replacements),
    originalMapping: mapping,
    aiRechecks: rechecks,
  };
}

/** Read the complete PDF once when OCR did not map required invoice values. */
export async function recheckMissingFieldsWithFullDocument(
  bytes: Buffer,
  evidence: SourceRef[],
  mapping: InvoiceMapping,
  readDocument: AiFullDocumentReader = readFullDocumentWithConfiguredAi,
  model = configuredModel(),
): Promise<{
  evidence: SourceRef[];
  mapping: InvoiceMapping;
  originalMapping: InvoiceMapping;
  aiRechecks: AiRecheck[];
}> {
  if (!needsFullDocumentFallback(mapping)) return { evidence, mapping, originalMapping: mapping, aiRechecks: [] };

  let attempted: InvoiceExtraction | null = null;
  try {
    attempted = fullInvoiceExtractionSchema.parse(await readDocument(bytes));
  } catch {
    // One attempt per document: preserve the missing values and its audit record.
  }
  const extracted = attempted && completeInvoiceExtraction(attempted) ? attempted : null;

  const byId = new Map(evidence.map((source) => [source.id, source]));
  const records: AiRecheck[] = [];
  const replacements = new Map<string, string>();
  const values = attempted ? extractedValueFields(attempted) : [];
  const extractedByField = new Map(values.map(({ field, value }) => [field, value ?? null]));
  const documentPage = await singlePageNumber(bytes);

  for (const { field, id } of fullDocumentTargets(mapping, extracted)) {
    const value = extractedByField.get(field)?.trim() || null;
    const source = id ? byId.get(id) : undefined;
    records.push({
      field,
      originalOcrValue: source?.content ?? "",
      ocrConfidence: source?.confidence ?? null,
      sourceId: source?.id ?? "document",
      page: source?.page ?? documentPage,
      aiValue: value,
      model,
      attemptedAt: new Date().toISOString(),
      outcome: extracted && value ? "resolved" : "needs_review",
    });
    if (extracted && value) replacements.set(field, `ai_full_document.${field}`);
  }

  const aiEvidence = records.flatMap((record) =>
    record.outcome === "resolved" && record.aiValue
      ? [
          {
            id: `ai_full_document.${record.field}`,
            content: record.aiValue,
            confidence: null,
            page: record.page,
            label: `${formatRecheckField(record.field)} full-document AI extraction`,
            sourceKind: "AI_RECHECK" as const,
          },
        ]
      : [],
  );
  return {
    evidence: sourceRefSchema.array().parse([...evidence, ...aiEvidence]),
    mapping: mergeFullDocumentMapping(mapping, extracted, replacements),
    originalMapping: mapping,
    aiRechecks: records,
  };
}

async function singlePageNumber(bytes: Buffer) {
  try {
    return (await PDFDocument.load(bytes)).getPageCount() === 1 ? 1 : null;
  } catch {
    return null;
  }
}

function recheckRecord(field: LowConfidenceField, aiValue: string | null, outcome: AiRecheck["outcome"], model: string | null): AiRecheck {
  return {
    field: field.field,
    originalOcrValue: field.source.content,
    ocrConfidence: field.source.confidence,
    sourceId: field.source.id,
    page: field.source.page,
    aiValue,
    model: field.source.page ? model : null,
    attemptedAt: new Date().toISOString(),
    outcome,
  };
}

async function readPageWithConfiguredAi(pagePdf: Buffer, fields: LowConfidenceField[]): Promise<Record<string, string | null>> {
  const responseSchema = aiRecheckResponseSchemaFor(fields);
  const prompt = `Read only these invoice extraction fields from the attached PDF page: ${fields
    .map((field) => `${field.field} (OCR read: ${JSON.stringify(field.source.content)})`)
    .join(
      ", ",
    )}. Return only the requested field values. Do not select a PO, map bundles, approve variances, receipts, or duplicates. Do not provide confidence scores.`;
  if (env.MAPPING_PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) throw new ProviderError("CONFIG", "OpenAI is not configured.");
    const client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: 30_000,
      maxRetries: 0,
    });
    const response = await client.responses.parse({
      model: env.OPENAI_MODEL,
      input: [
        { role: "system", content: "You extract document text only." },
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "invoice-page.pdf",
              file_data: `data:application/pdf;base64,${pagePdf.toString("base64")}`,
            },
            { type: "input_text", text: prompt },
          ],
        },
      ],
      text: {
        format: zodTextFormat(responseSchema, "invoice_reread"),
      },
    });
    if (!response.output_parsed) throw new ProviderError("AI_RECHECK", "AI returned no re-read values.");
    return responseSchema.parse(response.output_parsed).values;
  }

  if (!env.GEMINI_API_KEY) throw new ProviderError("CONFIG", "Gemini is not configured.");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "You extract document text only." }],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: pagePdf.toString("base64"),
                },
              },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              values: {
                type: "object",
                properties: Object.fromEntries(fields.map((field) => [field.field, { type: ["string", "null"] }])),
                required: fields.map((field) => field.field),
              },
            },
            required: ["values"],
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new ProviderError("AI_RECHECK", "Gemini re-read request failed.", {
      status: response.status,
    });
  const output = extractGeminiOutput(await response.json());
  if (!output) throw new ProviderError("AI_RECHECK", "Gemini returned no re-read values.");
  return responseSchema.parse(JSON.parse(output)).values;
}

async function readFullDocumentWithConfiguredAi(documentPdf: Buffer): Promise<InvoiceExtraction> {
  const prompt =
    "Read the complete attached invoice. Return every printed invoice header and current-invoice line item exactly as document text; use null only when a value is not present. Include fee-summary, progress-billing, and current-invoice rows when they contribute to the invoice total. Exclude previously invoiced amounts, prior balances, payments, and remaining balances from current line items. Split compact or pipe-delimited rows into their printed SKU, description, quantity, UOM, unit price, and amount fields. Do not select a purchase order, map bundles, approve variances, receipts, or duplicates. Do not calculate or provide confidence scores.";
  if (env.MAPPING_PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) throw new ProviderError("CONFIG", "OpenAI is not configured.");
    const client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: 30_000,
      maxRetries: 0,
    });
    const response = await client.responses.parse({
      model: env.OPENAI_MODEL,
      input: [
        { role: "system", content: "You extract document text only." },
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "invoice.pdf",
              file_data: `data:application/pdf;base64,${documentPdf.toString("base64")}`,
            },
            { type: "input_text", text: prompt },
          ],
        },
      ],
      text: {
        format: zodTextFormat(invoiceMappingSchema, "full_invoice_extraction"),
      },
    });
    if (!response.output_parsed) throw new ProviderError("AI_RECHECK", "AI returned no full-document extraction.");
    return fullInvoiceExtractionSchema.parse(response.output_parsed);
  }

  if (!env.GEMINI_API_KEY) throw new ProviderError("CONFIG", "Gemini is not configured.");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "You extract document text only." }],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: documentPdf.toString("base64"),
                },
              },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: fullInvoiceJsonSchema(),
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new ProviderError("AI_RECHECK", "Gemini full-document extraction failed.", {
      status: response.status,
    });
  const output = extractGeminiOutput(await response.json());
  if (!output) throw new ProviderError("AI_RECHECK", "Gemini returned no full-document extraction.");
  return fullInvoiceExtractionSchema.parse(JSON.parse(output));
}

async function singlePagePdf(bytes: Buffer, page: number) {
  const source = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  if (page < 1 || page > source.getPageCount()) throw new Error("Unknown page.");
  const output = await PDFDocument.create();
  const [copied] = await output.copyPages(source, [page - 1]);
  output.addPage(copied!);
  return Buffer.from(await output.save());
}

function configuredModel() {
  return env.MAPPING_PROVIDER === "openai" ? env.OPENAI_MODEL : env.GEMINI_MODEL;
}

function formatRecheckField(field: string) {
  return field.replace(/^lines\.\d+\./, "Line ").replace(/([A-Z])/g, " $1");
}

export async function mapEvidenceWithRetry(evidence: SourceRef[], provider = env.MAPPING_PROVIDER) {
  return withOneMappingRetry(async () => {
    const mapping = provider === "openai" ? await mapWithOpenAI(evidence) : await mapWithGemini(evidence);
    validateMapping(mapping, evidence);
    return mapping;
  });
}

async function mapWithOpenAI(evidence: SourceRef[]) {
  if (!env.OPENAI_API_KEY) throw new ProviderError("CONFIG", "OpenAI is not configured.");
  try {
    const client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: 30_000,
      maxRetries: 0,
    });
    const response = await client.responses.parse({
      model: env.OPENAI_MODEL,
      input: [
        {
          role: "system",
          content:
            "Map invoice fields only by selecting provided source IDs. Return IDs exactly as provided, return null when optional evidence is absent, and never construct a new ID. When equivalent sources contain the same observed value, select the highest-confidence source and prefer confidence of at least 0.75. Associate explicit tax-inclusion, tax-rate, and tax-amount evidence with the relevant line when the document does so. Never infer, rewrite, calculate, or decide values.",
        },
        { role: "user", content: JSON.stringify(evidence) },
      ],
      text: {
        format: zodTextFormat(invoiceMappingSchemaForEvidence(evidence), "invoice_mapping"),
      },
    });
    if (!response.output_parsed)
      throw new ProviderError("OPENAI_MAPPING", "OpenAI returned no mapping.", {
        model: env.OPENAI_MODEL,
        evidenceCount: evidence.length,
        malformed: true,
      });
    return invoiceMappingSchema.parse(response.output_parsed);
  } catch (caught) {
    if (caught instanceof ProviderError) throw caught;
    throw providerError("OPENAI_MAPPING", "OpenAI mapping request failed.", caught, {
      model: env.OPENAI_MODEL,
      evidenceCount: evidence.length,
    });
  }
}

async function mapWithGemini(evidence: SourceRef[]) {
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text:
                  "Map invoice fields only by selecting provided source IDs. " +
                  "Prefer the highest-confidence equivalent source and confidence of at least 0.75. " +
                  "Associate explicit tax evidence with its relevant line. " +
                  "Return IDs exactly as provided, use null when optional evidence is absent, and never construct IDs. Never infer or rewrite values.",
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: JSON.stringify(evidence) }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: invoiceMappingJsonSchemaForEvidence(evidence),
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (caught) {
    throw providerError("GEMINI_MAPPING", "Gemini mapping request failed.", caught, {
      model: env.GEMINI_MODEL,
      evidenceCount: evidence.length,
    });
  }

  if (!response.ok) {
    throw new ProviderError("GEMINI_MAPPING", "Gemini mapping request failed.", {
      model: env.GEMINI_MODEL,
      status: response.status,
      statusText: response.statusText,
      error: await safeResponseError(response),
      evidenceCount: evidence.length,
    });
  }

  const body = (await response.json()) as unknown;
  const output = extractGeminiOutput(body);
  if (!output) {
    throw new ProviderError("GEMINI_MAPPING", "Gemini returned no mapping.", {
      model: env.GEMINI_MODEL,
      evidenceCount: evidence.length,
    });
  }

  try {
    return invoiceMappingSchema.parse(JSON.parse(output));
  } catch (caught) {
    throw providerError("GEMINI_MAPPING", "Gemini returned malformed mapping.", caught, {
      model: env.GEMINI_MODEL,
      evidenceCount: evidence.length,
      malformed: true,
    });
  }
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
      for (const [index, item] of (field.valueArray ?? []).entries()) {
        for (const [childLabel, child] of Object.entries(item.valueObject ?? {})) {
          add(`item.${index}.${childLabel}`, childLabel, child, "ITEM");
        }
      }
    } else if (/tax/i.test(label) && field.valueArray?.length) {
      for (const [index, item] of field.valueArray.entries()) {
        for (const [childLabel, child] of Object.entries(item.valueObject ?? {})) {
          add(`tax.${index}.${childLabel}`, childLabel, child, "TAX");
        }
      }
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
      if (line.content) {
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
  }

  for (const [index, pair] of (result?.keyValuePairs ?? []).entries()) {
    for (const [part, element] of [
      ["key", pair.key],
      ["value", pair.value],
    ] as const) {
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
  if (!evidence.length && !allowEmpty) {
    throw new ProviderError("AZURE_EVIDENCE", "Azure returned no usable invoice evidence.");
  }
  return sourceRefSchema.array().parse(evidence);
}

function spansOverlap(left: { offset: number; length: number }, right: { offset: number; length: number }) {
  return left.offset < right.offset + right.length && right.offset < left.offset + left.length;
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
    mapping.lines = mapping.lines.map((line, index) => ({
      ...line,
      sku: `item.${index}.ProductCode`,
      quantity: `item.${index}.Quantity`,
    }));
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
  const pdf = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
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
    const raw = JSON.parse(await readFile(sourcesPath, "utf8")) as unknown;
    evidence = sourceRefSchema.array().parse(raw);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw caught;
  }

  const cases = JSON.parse(await readFile(path.resolve("data/cases.json"), "utf8")) as {
    fixtures: Record<
      string,
      {
        input: {
          vendor: string;
          invoice_number: string;
          invoice_date: string;
          po_number: string | null;
          currency: string;
          subtotal: string | null;
          tax: string | null;
          total: string;
          tax_note?: string;
          lines: Array<{
            sku: string;
            description: string;
            quantity: string;
            uom: string;
            unit_price: string;
            amount: string;
          }>;
        };
      }
    >;
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

function ref(id: string, label: string, content: string): SourceRef {
  return { id, label, content, confidence: 1, page: 1 };
}

function hasSource(evidence: SourceRef[], id: string) {
  return evidence.some((source) => source.id === id);
}

function recordedLineIndexes(evidence: SourceRef[]) {
  return [
    ...new Set(
      evidence
        .map((source) => source.id.match(/^case\.lines\.(\d+)\./)?.[1])
        .filter((index): index is string => Boolean(index))
        .map(Number),
    ),
  ].sort((left, right) => left - right);
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

function extractGeminiOutput(body: unknown) {
  const record = body as {
    output_text?: unknown;
    outputText?: unknown;
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  };
  if (typeof record.output_text === "string") return record.output_text;
  if (typeof record.outputText === "string") return record.outputText;
  const candidateText = record.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  return typeof candidateText === "string" ? candidateText : null;
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
