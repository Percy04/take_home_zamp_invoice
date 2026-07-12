import { readFile } from "node:fs/promises";
import path from "node:path";
import DocumentIntelligence, {
  getLongRunningPoller,
  isUnexpected,
} from "@azure-rest/ai-document-intelligence";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { sourceRefSchema, type SourceRef } from "../../shared/contracts.js";
import { env } from "./env.js";

const lineMappingSchema = z.object({
  sku: z.string().nullable(),
  description: z.string().nullable(),
  quantity: z.string(),
  uom: z.string(),
  unitPrice: z.string(),
  amount: z.string(),
  taxInclusion: z.string().nullable().optional(),
  taxRate: z.string().nullable().optional(),
  taxAmount: z.string().nullable().optional(),
});

export const invoiceMappingSchema = z.object({
  vendor: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  poNumber: z.string().nullable(),
  currency: z.string().nullable(),
  subtotal: z.string().nullable(),
  tax: z.string().nullable(),
  total: z.string(),
  taxNote: z.string().nullable().optional(),
  lines: z.array(lineMappingSchema).min(1),
});

export type InvoiceMapping = z.infer<typeof invoiceMappingSchema>;

const lineMappingJsonSchema = {
  type: "object",
  properties: {
    sku: {
      type: ["string", "null"],
      description: "Source ID for the invoice line SKU or product code.",
    },
    description: {
      type: ["string", "null"],
      description: "Source ID for the invoice line description.",
    },
    quantity: {
      type: "string",
      description: "Source ID for the invoice line quantity.",
    },
    uom: {
      type: "string",
      description: "Source ID for the invoice line unit of measure.",
    },
    unitPrice: {
      type: "string",
      description: "Source ID for the invoice line unit price.",
    },
    amount: {
      type: "string",
      description: "Source ID for the invoice line net or line amount.",
    },
    taxInclusion: {
      type: ["string", "null"],
      description:
        "Source ID explicitly stating whether this line includes tax.",
    },
    taxRate: {
      type: ["string", "null"],
      description: "Source ID for the tax rate associated with this line.",
    },
    taxAmount: {
      type: ["string", "null"],
      description: "Source ID for the tax amount associated with this line.",
    },
  },
  required: [
    "sku",
    "description",
    "quantity",
    "uom",
    "unitPrice",
    "amount",
    "taxInclusion",
    "taxRate",
    "taxAmount",
  ],
};

const invoiceMappingJsonSchema = {
  type: "object",
  properties: {
    vendor: { type: "string", description: "Source ID for vendor name." },
    invoiceNumber: {
      type: "string",
      description: "Source ID for invoice number.",
    },
    invoiceDate: { type: "string", description: "Source ID for invoice date." },
    poNumber: {
      type: ["string", "null"],
      description: "Source ID for purchase order number.",
    },
    currency: {
      type: ["string", "null"],
      description: "Source ID for currency.",
    },
    subtotal: {
      type: ["string", "null"],
      description: "Source ID for subtotal.",
    },
    tax: { type: ["string", "null"], description: "Source ID for tax amount." },
    total: { type: "string", description: "Source ID for invoice total." },
    lines: {
      type: "array",
      items: lineMappingJsonSchema,
      minItems: 1,
    },
  },
  required: [
    "vendor",
    "invoiceNumber",
    "invoiceDate",
    "poNumber",
    "currency",
    "subtotal",
    "tax",
    "total",
    "lines",
  ],
};

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

type ProviderStage =
  | "CONFIG"
  | "AZURE_ANALYZE"
  | "AZURE_POLL"
  | "AZURE_RESULT"
  | "AZURE_EVIDENCE"
  | "OPENAI_MAPPING"
  | "GEMINI_MAPPING"
  | "MAPPING_VALIDATION"
  | "RECORDED_PROVIDER";

type ProviderDiagnostic = string | number | boolean | null | undefined;

export class ProviderError extends Error {
  constructor(
    readonly stage: ProviderStage,
    message: string,
    readonly diagnostics: Record<string, ProviderDiagnostic> = {},
  ) {
    super(message);
  }
}

export async function extractAndMap(bytes: Buffer): Promise<{
  evidence: SourceRef[];
  mapping: InvoiceMapping;
}> {
  return env.PROVIDER_MODE === "live"
    ? extractAndMapLive(bytes)
    : extractAndMapRecorded(bytes);
}

export async function extractAndMapLive(bytes: Buffer) {
  const missing = [
    env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
      ? null
      : "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
    env.AZURE_DOCUMENT_INTELLIGENCE_KEY
      ? null
      : "AZURE_DOCUMENT_INTELLIGENCE_KEY",
    env.MAPPING_PROVIDER === "openai" && !env.OPENAI_API_KEY
      ? "OPENAI_API_KEY"
      : null,
    env.MAPPING_PROVIDER === "gemini" && !env.GEMINI_API_KEY
      ? "GEMINI_API_KEY"
      : null,
  ].filter(Boolean);
  if (
    !env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ||
    !env.AZURE_DOCUMENT_INTELLIGENCE_KEY ||
    (env.MAPPING_PROVIDER === "openai"
      ? !env.OPENAI_API_KEY
      : !env.GEMINI_API_KEY)
  ) {
    throw new ProviderError("CONFIG", "Live providers are not configured.", {
      missing: missing.join(", "),
    });
  }
  const client = DocumentIntelligence(
    env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
    { key: env.AZURE_DOCUMENT_INTELLIGENCE_KEY },
  );
  let result: AzureResult;
  try {
    const initial = await client
      .path("/documentModels/{modelId}:analyze", "prebuilt-invoice")
      .post({
        contentType: "application/json",
        body: { base64Source: bytes.toString("base64") },
        queryParameters: { features: ["keyValuePairs"] },
        abortSignal: AbortSignal.timeout(60_000),
      });
    if (isUnexpected(initial))
      throw new ProviderError(
        "AZURE_ANALYZE",
        "Azure analyze request failed.",
        {
          status: initial.status,
        },
      );
    const poller = getLongRunningPoller(client, initial);
    result = (
      await withTimeout(
        poller.pollUntilDone(),
        60_000,
        "Azure extraction timed out.",
      )
    ).body as unknown as AzureResult;
  } catch (caught) {
    if (caught instanceof ProviderError) throw caught;
    throw providerError(
      "AZURE_ANALYZE",
      "Azure analyze request failed.",
      caught,
    );
  }
  if (result.status !== "succeeded")
    throw new ProviderError("AZURE_RESULT", "Azure extraction failed.", {
      status: result.status ?? "unknown",
    });
  const evidence = buildSourceCatalogue(result);
  const mapping = await mapEvidenceWithRetry(evidence);
  return { evidence, mapping };
}

export async function mapEvidenceWithRetry(
  evidence: SourceRef[],
  provider = env.MAPPING_PROVIDER,
) {
  return withOneMappingRetry(async () => {
    const mapping =
      provider === "openai"
        ? await mapWithOpenAI(evidence)
        : await mapWithGemini(evidence);
    validateMapping(mapping, evidence);
    return preferReliableEvidence(mapping, evidence);
  });
}

export async function withOneMappingRetry<T>(operation: () => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (caught) {
      if (attempt >= 1 || !isRetryableMappingError(caught)) throw caught;
    }
  }
}

async function mapWithOpenAI(evidence: SourceRef[]) {
  if (!env.OPENAI_API_KEY)
    throw new ProviderError("CONFIG", "OpenAI is not configured.");
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
      text: { format: zodTextFormat(invoiceMappingSchema, "invoice_mapping") },
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
    throw providerError(
      "OPENAI_MAPPING",
      "OpenAI mapping request failed.",
      caught,
      {
        model: env.OPENAI_MODEL,
        evidenceCount: evidence.length,
      },
    );
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
            responseSchema: invoiceMappingJsonSchema,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (caught) {
    throw providerError(
      "GEMINI_MAPPING",
      "Gemini mapping request failed.",
      caught,
      {
        model: env.GEMINI_MODEL,
        evidenceCount: evidence.length,
      },
    );
  }

  if (!response.ok) {
    throw new ProviderError(
      "GEMINI_MAPPING",
      "Gemini mapping request failed.",
      {
        model: env.GEMINI_MODEL,
        status: response.status,
        statusText: response.statusText,
        error: await safeResponseError(response),
        evidenceCount: evidence.length,
      },
    );
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
    throw providerError(
      "GEMINI_MAPPING",
      "Gemini returned malformed mapping.",
      caught,
      {
        model: env.GEMINI_MODEL,
        evidenceCount: evidence.length,
        malformed: true,
      },
    );
  }
}

export function buildSourceCatalogue(payload: AzureResult): SourceRef[] {
  const result = payload.analyzeResult;
  const fields = result?.documents?.[0]?.fields ?? {};
  const evidence: SourceRef[] = [];
  const add = (
    id: string,
    label: string,
    field: AzureField,
    sourceKind: SourceRef["sourceKind"],
  ) => {
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
        for (const [childLabel, child] of Object.entries(
          item.valueObject ?? {},
        )) {
          add(`item.${index}.${childLabel}`, childLabel, child, "ITEM");
        }
      }
    } else if (/tax/i.test(label) && field.valueArray?.length) {
      for (const [index, item] of field.valueArray.entries()) {
        for (const [childLabel, child] of Object.entries(
          item.valueObject ?? {},
        )) {
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
        const overlappingWords = (page.words ?? []).filter((word) =>
          line.spans?.some((span) => spansOverlap(span, word.span)),
        );
        evidence.push({
          id: `line.${page.pageNumber}.l${index}`,
          content: line.content,
          confidence: overlappingWords.length
            ? Math.min(...overlappingWords.map((word) => word.confidence))
            : null,
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
  if (!evidence.length) {
    throw new ProviderError(
      "AZURE_EVIDENCE",
      "Azure returned no usable invoice evidence.",
    );
  }
  return sourceRefSchema.array().parse(evidence);
}

function spansOverlap(
  left: { offset: number; length: number },
  right: { offset: number; length: number },
) {
  return (
    left.offset < right.offset + right.length &&
    right.offset < left.offset + left.length
  );
}

export function validateMapping(
  mapping: InvoiceMapping,
  evidence: SourceRef[],
) {
  const known = new Set(evidence.map((source) => source.id));
  const ids = [
    mapping.vendor,
    mapping.invoiceNumber,
    mapping.invoiceDate,
    mapping.poNumber,
    mapping.currency,
    mapping.subtotal,
    mapping.tax,
    mapping.total,
    mapping.taxNote,
    ...mapping.lines.flatMap(Object.values),
  ].filter((id): id is string => typeof id === "string");
  const unknownIds = [...new Set(ids.filter((id) => !known.has(id)))];
  if (unknownIds.length) {
    throw new ProviderError(
      "MAPPING_VALIDATION",
      "Mapper referenced unknown evidence.",
      {
        evidenceCount: evidence.length,
        unknownIds: unknownIds.slice(0, 10).join(", "),
        malformed: true,
      },
    );
  }
}

export function preferReliableEvidence(
  mapping: InvoiceMapping,
  evidence: SourceRef[],
): InvoiceMapping {
  const byId = new Map(evidence.map((source) => [source.id, source]));
  const replace = (id: string | null | undefined) => {
    if (!id) return id ?? null;
    const selected = byId.get(id);
    if (
      !selected ||
      selected.confidence === null ||
      selected.confidence >= 0.75
    )
      return id;
    const content = selected.content.normalize("NFKC").trim();
    const candidates = evidence
      .filter(
        (candidate) =>
          candidate.id !== id &&
          candidate.content.normalize("NFKC").trim() === content &&
          (candidate.confidence === null || candidate.confidence >= 0.75),
      )
      .sort(
        (left, right) =>
          evidencePriority(left) - evidencePriority(right) ||
          left.id.localeCompare(right.id),
      );
    const bestPriority = candidates[0] ? evidencePriority(candidates[0]) : null;
    const best = candidates.filter(
      (candidate) => evidencePriority(candidate) === bestPriority,
    );
    return best.length === 1 ? best[0]!.id : id;
  };
  return invoiceMappingSchema.parse({
    ...mapping,
    vendor: replace(mapping.vendor),
    invoiceNumber: replace(mapping.invoiceNumber),
    invoiceDate: replace(mapping.invoiceDate),
    poNumber: replace(mapping.poNumber),
    currency: replace(mapping.currency),
    subtotal: replace(mapping.subtotal),
    tax: replace(mapping.tax),
    total: replace(mapping.total),
    taxNote: replace(mapping.taxNote),
    lines: mapping.lines.map((line) => ({
      ...line,
      sku: replace(line.sku),
      description: replace(line.description),
      quantity: replace(line.quantity),
      uom: replace(line.uom),
      unitPrice: replace(line.unitPrice),
      amount: replace(line.amount),
      taxInclusion: replace(line.taxInclusion),
      taxRate: replace(line.taxRate),
      taxAmount: replace(line.taxAmount),
    })),
  });
}

function evidencePriority(source: SourceRef) {
  return {
    FIELD: 0,
    ITEM: 0,
    TAX: 0,
    KEY_VALUE: 1,
    TABLE: 2,
    OCR_LINE: 3,
    RECORDED: 4,
  }[source.sourceKind ?? "RECORDED"];
}

async function extractAndMapRecorded(bytes: Buffer): Promise<{
  evidence: SourceRef[];
  mapping: InvoiceMapping;
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
  validateMapping(mapping, evidence);
  return { evidence, mapping };
}

async function recordingForDocument(bytes: Buffer) {
  const pdf = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const title = pdf.getTitle();
  if (title === "Invoice ACME-2026-001") return "happy";
  if (title === "Invoice ACME-2026-000") return "duplicate";
  if (title === "Invoice DELTA-2026-010") return "receipt_capacity";
  if (title === "Invoice ACME-2026-003") return "bundle_known";
  if (title === "Invoice ACME-2026-005") return "tax_inclusive";
  if (title === "Invoice ACME-2026-002") return "missing_po";
  if (title === "Invoice ACME-2026-004") return "bundle_unknown";
  throw new ProviderError(
    "RECORDED_PROVIDER",
    "No recorded provider response for this document.",
  );
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

  const cases = JSON.parse(
    await readFile(path.resolve("data/cases.json"), "utf8"),
  ) as {
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
    ...(input.subtotal
      ? [ref("case.subtotal", "SubTotal", input.subtotal)]
      : []),
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
  return error instanceof ProviderError &&
    ["OPENAI_MAPPING", "GEMINI_MAPPING", "MAPPING_VALIDATION"].includes(
      error.stage,
    )
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
  const candidateText = record.candidates?.[0]?.content?.parts?.find(
    (part) => typeof part.text === "string",
  )?.text;
  return typeof candidateText === "string" ? candidateText : null;
}

function providerError(
  stage: ProviderStage,
  message: string,
  caught: unknown,
  extra: Record<string, ProviderDiagnostic> = {},
) {
  return new ProviderError(stage, message, { ...extra, ...safeError(caught) });
}

function safeError(error: unknown): Record<string, ProviderDiagnostic> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const shaped = error as Error & {
    status?: number;
    code?: string;
    type?: string;
  };
  return {
    name: shaped.name,
    message: shaped.message,
    status: shaped.status,
    code: shaped.code,
    type: shaped.type,
  };
}

async function safeResponseError(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; status?: unknown; message?: unknown };
    };
    const message =
      typeof body.error?.message === "string"
        ? body.error.message.slice(0, 500)
        : undefined;
    return [body.error?.code, body.error?.status, message]
      .filter((part) => part !== undefined)
      .join(" ");
  } catch {
    return undefined;
  }
}

function isRetryableMappingError(error: unknown) {
  if (!(error instanceof ProviderError)) return true;
  const status = error.diagnostics.status;
  if (error.diagnostics.malformed) return true;
  return (
    typeof status !== "number" ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
) {
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
