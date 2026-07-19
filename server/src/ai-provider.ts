import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { SourceRef } from "../../shared/contracts.js";
import type { LowConfidenceField } from "./ai-rechecks.js";
import { env } from "./env.js";
import {
  fullInvoiceExtractionSchema,
  fullInvoiceJsonSchema,
  invoiceMappingJsonSchemaForEvidence,
  invoiceMappingSchema,
  invoiceMappingSchemaForEvidence,
  type InvoiceExtraction,
  type InvoiceMapping,
} from "./invoice-mapping.js";
import { ProviderError, providerError, safeResponseError } from "./provider-errors.js";

export interface AiModelAdapter {
  readonly model: string;
  mapEvidence(evidence: SourceRef[]): Promise<InvoiceMapping>;
  readPage(pagePdf: Buffer, fields: LowConfidenceField[]): Promise<Record<string, string | null>>;
  readDocument(documentPdf: Buffer): Promise<InvoiceExtraction>;
}

export class OpenAiAdapter implements AiModelAdapter {
  readonly model = env.OPENAI_MODEL;
  private readonly client: OpenAI;

  constructor() {
    if (!env.OPENAI_API_KEY) throw new ProviderError("CONFIG", "OpenAI is not configured.");
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 0 });
  }

  async mapEvidence(evidence: SourceRef[]) {
    try {
      const response = await this.client.responses.parse({
        model: this.model,
        input: [
          {
            role: "system",
            content:
              "Map invoice fields only by selecting provided source IDs. Return IDs exactly as provided, return null when optional evidence is absent, and never construct a new ID. When equivalent sources contain the same observed value, select the highest-confidence source and prefer confidence of at least 0.75. Associate explicit tax-inclusion, tax-rate, and tax-amount evidence with the relevant line when the document does so. Never infer, rewrite, calculate, or decide values.",
          },
          { role: "user", content: JSON.stringify(evidence) },
        ],
        text: { format: zodTextFormat(invoiceMappingSchemaForEvidence(evidence), "invoice_mapping") },
      });
      if (!response.output_parsed)
        throw new ProviderError("OPENAI_MAPPING", "OpenAI returned no mapping.", {
          model: this.model,
          evidenceCount: evidence.length,
          malformed: true,
        });
      return invoiceMappingSchema.parse(response.output_parsed);
    } catch (caught) {
      if (caught instanceof ProviderError) throw caught;
      throw providerError("OPENAI_MAPPING", "OpenAI mapping request failed.", caught, {
        model: this.model,
        evidenceCount: evidence.length,
      });
    }
  }

  async readPage(pagePdf: Buffer, fields: LowConfidenceField[]) {
    const responseSchema = pageRereadResponseSchema(fields);
    const response = await this.client.responses.parse({
      model: this.model,
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
            { type: "input_text", text: pageRereadPrompt(fields) },
          ],
        },
      ],
      text: { format: zodTextFormat(responseSchema, "invoice_reread") },
    });
    if (!response.output_parsed) throw new ProviderError("AI_RECHECK", "AI returned no re-read values.");
    return responseSchema.parse(response.output_parsed).values;
  }

  async readDocument(documentPdf: Buffer) {
    const response = await this.client.responses.parse({
      model: this.model,
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
            { type: "input_text", text: fullDocumentPrompt },
          ],
        },
      ],
      text: { format: zodTextFormat(invoiceMappingSchema, "full_invoice_extraction") },
    });
    if (!response.output_parsed) throw new ProviderError("AI_RECHECK", "AI returned no full-document extraction.");
    return fullInvoiceExtractionSchema.parse(response.output_parsed);
  }
}

export class GeminiAdapter implements AiModelAdapter {
  readonly model = env.GEMINI_MODEL;

  constructor() {
    if (!env.GEMINI_API_KEY) throw new ProviderError("CONFIG", "Gemini is not configured.");
  }

  async mapEvidence(evidence: SourceRef[]) {
    let response: Response;
    try {
      response = await this.request({
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
        contents: [{ role: "user", parts: [{ text: JSON.stringify(evidence) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: invoiceMappingJsonSchemaForEvidence(evidence),
        },
      });
    } catch (caught) {
      throw providerError("GEMINI_MAPPING", "Gemini mapping request failed.", caught, {
        model: this.model,
        evidenceCount: evidence.length,
      });
    }
    if (!response.ok) {
      throw new ProviderError("GEMINI_MAPPING", "Gemini mapping request failed.", {
        model: this.model,
        status: response.status,
        statusText: response.statusText,
        error: await safeResponseError(response),
        evidenceCount: evidence.length,
      });
    }
    const output = extractGeminiOutput(await response.json());
    if (!output) throw new ProviderError("GEMINI_MAPPING", "Gemini returned no mapping.", { model: this.model, evidenceCount: evidence.length });
    try {
      return invoiceMappingSchema.parse(JSON.parse(output));
    } catch (caught) {
      throw providerError("GEMINI_MAPPING", "Gemini returned malformed mapping.", caught, {
        model: this.model,
        evidenceCount: evidence.length,
        malformed: true,
      });
    }
  }

  async readPage(pagePdf: Buffer, fields: LowConfidenceField[]) {
    const responseSchema = pageRereadResponseSchema(fields);
    const response = await this.request({
      systemInstruction: { parts: [{ text: "You extract document text only." }] },
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "application/pdf", data: pagePdf.toString("base64") } },
            { text: pageRereadPrompt(fields) },
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
    });
    if (!response.ok) throw new ProviderError("AI_RECHECK", "Gemini re-read request failed.", { status: response.status });
    const output = extractGeminiOutput(await response.json());
    if (!output) throw new ProviderError("AI_RECHECK", "Gemini returned no re-read values.");
    return responseSchema.parse(JSON.parse(output)).values;
  }

  async readDocument(documentPdf: Buffer) {
    const response = await this.request({
      systemInstruction: { parts: [{ text: "You extract document text only." }] },
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "application/pdf", data: documentPdf.toString("base64") } },
            { text: fullDocumentPrompt },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", responseSchema: fullInvoiceJsonSchema() },
    });
    if (!response.ok) throw new ProviderError("AI_RECHECK", "Gemini full-document extraction failed.", { status: response.status });
    const output = extractGeminiOutput(await response.json());
    if (!output) throw new ProviderError("AI_RECHECK", "Gemini returned no full-document extraction.");
    return fullInvoiceExtractionSchema.parse(JSON.parse(output));
  }

  private request(body: unknown) {
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }
}

export function configuredAiAdapter(): AiModelAdapter {
  return env.MAPPING_PROVIDER === "openai" ? new OpenAiAdapter() : new GeminiAdapter();
}

function pageRereadResponseSchema(fields: LowConfidenceField[]) {
  return z.object({ values: z.object(Object.fromEntries(fields.map((field) => [field.field, z.string().nullable()]))) });
}

function pageRereadPrompt(fields: LowConfidenceField[]) {
  return `Read only these invoice extraction fields from the attached PDF page: ${fields
    .map((field) => `${field.field} (OCR read: ${JSON.stringify(field.source.content)})`)
    .join(", ")}. Return only the requested field values. Do not select a PO, map bundles, approve variances, receipts, or duplicates. Do not provide confidence scores.`;
}

const fullDocumentPrompt =
  "Read the complete attached invoice. Return every printed invoice header and current-invoice line item exactly as document text; use null only when a value is not present. Include fee-summary, progress-billing, and current-invoice rows when they contribute to the invoice total. Exclude previously invoiced amounts, prior balances, payments, and remaining balances from current line items. Split compact or pipe-delimited rows into their printed SKU, description, quantity, UOM, unit price, and amount fields. Do not select a purchase order, map bundles, approve variances, receipts, or duplicates. Do not calculate or provide confidence scores.";

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
