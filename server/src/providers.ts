import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { sourceRefSchema, type SourceRef } from "../../shared/contracts.js";
import { env } from "./env.js";

const lineMappingSchema = z.object({
  sku: z.string(),
  description: z.string(),
  quantity: z.string(),
  uom: z.string(),
  unitPrice: z.string(),
  amount: z.string(),
});

const invoiceMappingSchema = z.object({
  vendor: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  poNumber: z.string(),
  currency: z.string(),
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
      type: "string",
      description: "Source ID for the invoice line SKU or product code.",
    },
    description: {
      type: "string",
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
  },
  required: ["sku", "description", "quantity", "uom", "unitPrice", "amount"],
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
      type: "string",
      description: "Source ID for purchase order number.",
    },
    currency: { type: "string", description: "Source ID for currency." },
    subtotal: { type: "string", description: "Source ID for subtotal." },
    tax: { type: "string", description: "Source ID for tax amount." },
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
  valueArray?: Array<{ valueObject?: Record<string, AzureField> }>;
};
type AzureResult = {
  status?: string;
  analyzeResult?: {
    documents?: Array<{ fields?: Record<string, AzureField> }>;
    pages?: Array<{
      pageNumber: number;
      lines?: Array<{ content?: string }>;
    }>;
  };
};

type ProviderStage =
  | "CONFIG"
  | "AZURE_ANALYZE"
  | "AZURE_POLL"
  | "AZURE_RESULT"
  | "AZURE_EVIDENCE"
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
    env.GEMINI_API_KEY ? null : "GEMINI_API_KEY",
  ].filter(Boolean);
  if (
    !env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ||
    !env.AZURE_DOCUMENT_INTELLIGENCE_KEY ||
    !env.GEMINI_API_KEY
  ) {
    throw new ProviderError("CONFIG", "Live providers are not configured.", {
      missing: missing.join(", "),
    });
  }
  const endpoint = env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT.replace(/\/$/, "");
  let analyzed: Response;
  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-invoice:analyze?api-version=2024-11-30`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      analyzed = await fetch(analyzeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "Ocp-Apim-Subscription-Key": env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
        },
        body: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (caught) {
      throw providerError(
        "AZURE_ANALYZE",
        "Azure analyze request failed.",
        caught,
      );
    }
    if (analyzed.status !== 429 || attempt >= 2) break;
    await waitForRetry(analyzed, attempt);
  }
  if (!analyzed.ok) {
    throw new ProviderError("AZURE_ANALYZE", "Azure analyze request failed.", {
      status: analyzed.status,
      statusText: analyzed.statusText,
    });
  }
  const operation = analyzed.headers.get("operation-location");
  if (!operation)
    throw new ProviderError(
      "AZURE_ANALYZE",
      "Azure returned no operation location.",
      { status: analyzed.status },
    );

  let result: AzureResult | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    let polled: Response;
    try {
      polled = await fetch(operation, {
        headers: {
          "Ocp-Apim-Subscription-Key": env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (caught) {
      throw providerError("AZURE_POLL", "Azure polling request failed.", caught, {
        attempt,
      });
    }
    if (!polled.ok) {
      if (polled.status === 429) {
        await waitForRetry(polled, attempt);
        continue;
      }
      throw new ProviderError("AZURE_POLL", "Azure polling request failed.", {
        attempt,
        status: polled.status,
        statusText: polled.statusText,
      });
    }
    result = (await polled.json()) as AzureResult;
    if (result.status === "succeeded") break;
    if (result.status === "failed") {
      throw new ProviderError("AZURE_RESULT", "Azure extraction failed.", {
        attempt,
        status: result.status,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (result?.status !== "succeeded") {
    throw new ProviderError("AZURE_RESULT", "Azure extraction timed out.", {
      status: result?.status ?? "unknown",
    });
  }
  const evidence = buildSourceCatalogue(result);
  const mapping = await mapWithGemini(evidence);
  validateMapping(mapping, evidence);
  return { evidence, mapping };
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
                  "Return IDs exactly as provided. Never infer or rewrite values.",
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
    });
  }
}

function buildSourceCatalogue(payload: AzureResult): SourceRef[] {
  const result = payload.analyzeResult;
  const fields = result?.documents?.[0]?.fields ?? {};
  const evidence: SourceRef[] = [];
  const add = (id: string, label: string, field: AzureField) => {
    if (!field.content) return;
    evidence.push({
      id,
      content: field.content,
      confidence: field.confidence ?? null,
      page: field.boundingRegions?.[0]?.pageNumber ?? null,
      label,
    });
  };
  for (const [label, field] of Object.entries(fields)) {
    if (label === "Items") {
      for (const [index, item] of (field.valueArray ?? []).entries()) {
        for (const [childLabel, child] of Object.entries(
          item.valueObject ?? {},
        )) {
          add(`item.${index}.${childLabel}`, childLabel, child);
        }
      }
    } else {
      add(`field.${label}`, label, field);
    }
  }
  for (const page of result?.pages ?? []) {
    for (const [index, line] of (page.lines ?? []).entries()) {
      if (line.content) {
        evidence.push({
          id: `line.${page.pageNumber}.l${index}`,
          content: line.content,
          confidence: null,
          page: page.pageNumber,
          label: "OCR line",
        });
      }
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

function validateMapping(mapping: InvoiceMapping, evidence: SourceRef[]) {
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
  if (ids.some((id) => !known.has(id))) {
    throw new ProviderError(
      "MAPPING_VALIDATION",
      "Gemini referenced unknown evidence.",
      { evidenceCount: evidence.length },
    );
  }
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
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 === "f00e5c72ed010b3e27369d575c85a148e8677a411d273c7a8ed42c164aca8e93")
    return "happy_layout_c_scanned";
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
  return error instanceof ProviderError &&
    ["GEMINI_MAPPING", "MAPPING_VALIDATION"].includes(error.stage)
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

async function waitForRetry(response: Response, attempt: number) {
  const retryAfter = Number(response.headers.get("retry-after"));
  const delay = Number.isFinite(retryAfter)
    ? retryAfter * 1000
    : Math.min(5000, 750 * (attempt + 1));
  await new Promise((resolve) => setTimeout(resolve, delay));
}
