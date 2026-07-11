import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
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
  subtotal: z.string(),
  tax: z.string(),
  total: z.string(),
  lines: z.array(lineMappingSchema).min(1),
});

export type InvoiceMapping = z.infer<typeof invoiceMappingSchema>;

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

export async function extractAndMap(bytes: Buffer): Promise<{
  evidence: SourceRef[];
  mapping: InvoiceMapping;
}> {
  return env.PROVIDER_MODE === "live"
    ? extractAndMapLive(bytes)
    : extractAndMapRecorded(bytes);
}

async function extractAndMapLive(bytes: Buffer) {
  if (
    !env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ||
    !env.AZURE_DOCUMENT_INTELLIGENCE_KEY ||
    !env.OPENAI_API_KEY
  ) {
    throw new Error("Live providers are not configured.");
  }
  const endpoint = env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT.replace(/\/$/, "");
  const analyzed = await fetch(
    `${endpoint}/documentintelligence/documentModels/prebuilt-invoice:analyze?api-version=2024-11-30`,
    {
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
    },
  );
  if (!analyzed.ok) throw new Error("Azure extraction failed.");
  const operation = analyzed.headers.get("operation-location");
  if (!operation) throw new Error("Azure returned no operation location.");

  let result: AzureResult | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const polled = await fetch(operation, {
      headers: {
        "Ocp-Apim-Subscription-Key": env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!polled.ok) throw new Error("Azure extraction polling failed.");
    result = (await polled.json()) as AzureResult;
    if (result.status === "succeeded") break;
    if (result.status === "failed")
      throw new Error("Azure could not extract the invoice.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (result?.status !== "succeeded")
    throw new Error("Azure extraction timed out.");
  const evidence = buildSourceCatalogue(result);
  const openai = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    timeout: 30_000,
    maxRetries: 1,
  });
  const response = await openai.responses.parse({
    model: env.OPENAI_MODEL,
    input: [
      {
        role: "system",
        content:
          "Map invoice fields only by selecting provided source IDs. Never infer or rewrite values.",
      },
      { role: "user", content: JSON.stringify(evidence) },
    ],
    text: { format: zodTextFormat(invoiceMappingSchema, "invoice_mapping") },
  });
  const mapping = response.output_parsed;
  if (!mapping) throw new Error("OpenAI returned no invoice mapping.");
  validateMapping(mapping, evidence);
  return { evidence, mapping };
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
  if (!evidence.length)
    throw new Error("Azure returned no usable invoice evidence.");
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
    ...mapping.lines.flatMap(Object.values),
  ];
  if (ids.some((id) => !known.has(id)))
    throw new Error("OpenAI referenced unknown evidence.");
}

async function extractAndMapRecorded(bytes: Buffer): Promise<{
  evidence: SourceRef[];
  mapping: InvoiceMapping;
}> {
  const recording = await recordingForDocument(bytes);
  const raw = JSON.parse(
    await readFile(
      path.resolve(`data/recordings/${recording}_sources.json`),
      "utf8",
    ),
  ) as unknown;
  const evidence = sourceRefSchema.array().parse(raw);
  const mapping: InvoiceMapping = {
    vendor: "field.VendorName",
    invoiceNumber: "field.InvoiceId",
    invoiceDate: "field.InvoiceDate",
    poNumber: "field.PurchaseOrder",
    currency: "line.1.l9",
    subtotal: "field.SubTotal",
    tax: "field.TotalTax",
    total: "field.InvoiceTotal",
    lines: [0, 1].map((index) => ({
      sku: `item.${index}.ProductCode`,
      description: `item.${index}.Description`,
      quantity: `item.${index}.Quantity`,
      uom: `item.${index}.Unit`,
      unitPrice: `item.${index}.UnitPrice`,
      amount: `item.${index}.Amount`,
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
  if (pdf.getTitle() === "Invoice ACME-2026-001") return "happy";
  throw new Error("No recorded provider response for this document.");
}
