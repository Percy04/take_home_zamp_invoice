import { PDFDocument } from "pdf-lib";
import { sourceRefSchema, type AiRecheck, type SourceRef } from "../../shared/contracts.js";
import {
  completeInvoiceExtraction,
  extractedValueFields,
  fullDocumentTargets,
  fullInvoiceExtractionSchema,
  lowConfidenceMappedFields,
  mergeFullDocumentMapping,
  needsFullDocumentFallback,
  replaceMappedEvidence,
  type InvoiceMapping,
} from "./invoice-mapping.js";

export type LowConfidenceField = {
  field: string;
  source: SourceRef;
};

export type AiPageReader = (pagePdf: Buffer, fields: LowConfidenceField[]) => Promise<Record<string, string | null>>;
export type AiFullDocumentReader = (documentPdf: Buffer) => Promise<unknown>;

export type AiRecheckResult = {
  evidence: SourceRef[];
  mapping: InvoiceMapping;
  originalMapping: InvoiceMapping;
  aiRechecks: AiRecheck[];
};

/** Re-read each affected PDF page once; the response can only replace extraction values. */
export async function recheckLowConfidenceFields(
  bytes: Buffer,
  evidence: SourceRef[],
  mapping: InvoiceMapping,
  readPage: AiPageReader,
  model: string | null = null,
): Promise<AiRecheckResult> {
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
      if (answered) {
        answeredFields.add(field.field);
        replacements.set(field.field, `ai_recheck.${field.field}`);
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
  readDocument: AiFullDocumentReader,
  model: string | null = null,
): Promise<AiRecheckResult> {
  if (!needsFullDocumentFallback(mapping)) return { evidence, mapping, originalMapping: mapping, aiRechecks: [] };

  let attempted = null;
  try {
    attempted = fullInvoiceExtractionSchema.parse(await readDocument(bytes));
  } catch {
    // One attempt per document: preserve the missing values and its audit record.
  }
  const extracted = attempted && completeInvoiceExtraction(attempted) ? attempted : null;

  const byId = new Map(evidence.map((source) => [source.id, source]));
  const records: AiRecheck[] = [];
  const replacements = new Map<string, string>();
  const extractedByField = new Map((attempted ? extractedValueFields(attempted) : []).map(({ field, value }) => [field, value ?? null]));
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

async function singlePagePdf(bytes: Buffer, page: number) {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  if (page < 1 || page > source.getPageCount()) throw new Error("Unknown page.");
  const output = await PDFDocument.create();
  const [copied] = await output.copyPages(source, [page - 1]);
  output.addPage(copied!);
  return Buffer.from(await output.save());
}

async function singlePageNumber(bytes: Buffer) {
  try {
    return (await PDFDocument.load(bytes)).getPageCount() === 1 ? 1 : null;
  } catch {
    return null;
  }
}

function formatRecheckField(field: string) {
  return field.replace(/^lines\.\d+\./, "Line ").replace(/([A-Z])/g, " $1");
}
