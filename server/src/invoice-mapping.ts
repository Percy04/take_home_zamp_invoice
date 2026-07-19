import { z } from "zod";
import type { SourceRef } from "../../shared/contracts.js";
import { ProviderError } from "./provider-errors.js";

const lineMappingSchema = z.object({
  sku: z.string().nullable(),
  description: z.string().nullable(),
  quantity: z.string().nullable(),
  uom: z.string().nullable(),
  unitPrice: z.string().nullable(),
  amount: z.string().nullable(),
  taxInclusion: z.string().nullable().optional(),
  taxRate: z.string().nullable().optional(),
  taxAmount: z.string().nullable().optional(),
});

export const invoiceMappingSchema = z.object({
  vendor: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  poNumber: z.string().nullable(),
  currency: z.string().nullable(),
  subtotal: z.string().nullable(),
  tax: z.string().nullable(),
  total: z.string().nullable(),
  taxNote: z.string().nullable().optional(),
  lines: z.array(lineMappingSchema),
});

export type InvoiceMapping = z.infer<typeof invoiceMappingSchema>;
declare const fullInvoiceExtractionBrand: unique symbol;
export type InvoiceExtraction = InvoiceMapping & { readonly [fullInvoiceExtractionBrand]: true };
export const fullInvoiceExtractionSchema = invoiceMappingSchema.transform((value) => value as InvoiceExtraction);

export const mappingHeaderFields = [
  "vendor",
  "invoiceNumber",
  "invoiceDate",
  "poNumber",
  "currency",
  "subtotal",
  "tax",
  "total",
  "taxNote",
] as const;
export const mappingLineFields = ["sku", "description", "quantity", "uom", "unitPrice", "amount", "taxInclusion", "taxRate", "taxAmount"] as const;

export function invoiceMappingSchemaForEvidence(evidence: SourceRef[]) {
  const ids = [...new Set(evidence.map((source) => source.id))];
  if (!ids.length) throw new Error("Evidence is required for source mapping.");
  const sourceId = z.enum(ids as [string, ...string[]]);
  const optionalSourceId = sourceId.nullable();
  const line = z.object({
    sku: optionalSourceId,
    description: optionalSourceId,
    quantity: optionalSourceId,
    uom: optionalSourceId,
    unitPrice: optionalSourceId,
    amount: optionalSourceId,
    taxInclusion: optionalSourceId.optional(),
    taxRate: optionalSourceId.optional(),
    taxAmount: optionalSourceId.optional(),
  });
  return z.object({
    vendor: optionalSourceId,
    invoiceNumber: optionalSourceId,
    invoiceDate: optionalSourceId,
    poNumber: optionalSourceId,
    currency: optionalSourceId,
    subtotal: optionalSourceId,
    tax: optionalSourceId,
    total: optionalSourceId,
    taxNote: optionalSourceId.optional(),
    lines: z.array(line),
  });
}

export function invoiceMappingJsonSchemaForEvidence(evidence: SourceRef[]) {
  const ids = [...new Set(evidence.map((source) => source.id))];
  const optionalSourceId = { type: ["string", "null"], enum: [...ids, null] };
  const line = {
    type: "object",
    properties: Object.fromEntries(mappingLineFields.map((field) => [field, optionalSourceId])),
    required: [...mappingLineFields],
  };
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(mappingHeaderFields.map((field) => [field, optionalSourceId])),
      lines: { type: "array", items: line },
    },
    required: [...mappingHeaderFields, "lines"],
  };
}

export function fullInvoiceJsonSchema() {
  const value = { type: ["string", "null"] };
  return {
    type: "object",
    properties: {
      ...Object.fromEntries(mappingHeaderFields.map((field) => [field, value])),
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: Object.fromEntries(mappingLineFields.map((field) => [field, value])),
          required: [...mappingLineFields],
        },
      },
    },
    required: [...mappingHeaderFields, "lines"],
  };
}

export function emptyInvoiceMapping(): InvoiceMapping {
  return {
    vendor: null,
    invoiceNumber: null,
    invoiceDate: null,
    poNumber: null,
    currency: null,
    subtotal: null,
    tax: null,
    total: null,
    taxNote: null,
    lines: [],
  };
}

export function mappedEvidenceFields(mapping: InvoiceMapping) {
  return [
    ...mappingHeaderFields.map((field) => ({ field, id: mapping[field] })),
    ...mapping.lines.flatMap((line, index) =>
      mappingLineFields.map((field) => ({ field: `lines.${index}.${field}`, id: line[field] })),
    ),
  ];
}

export function lowConfidenceMappedFields(evidence: SourceRef[], mapping: InvoiceMapping) {
  const byId = new Map(evidence.map((source) => [source.id, source]));
  return mappedEvidenceFields(mapping).flatMap(({ field, id }) => {
    const source = id ? byId.get(id) : undefined;
    return source && source.confidence !== null && source.confidence < 0.75 ? [{ field, source }] : [];
  });
}

export function replaceMappedEvidence(mapping: InvoiceMapping, replacements: Map<string, string | null>): InvoiceMapping {
  const replace = (field: string, id: string | null | undefined) =>
    replacements.has(field) ? (replacements.get(field) ?? null) : (id ?? null);
  return invoiceMappingSchema.parse({
    ...mapping,
    ...Object.fromEntries(mappingHeaderFields.map((field) => [field, replace(field, mapping[field])])),
    lines: mapping.lines.map((line, index) => ({
      ...line,
      ...Object.fromEntries(mappingLineFields.map((field) => [field, replace(`lines.${index}.${field}`, line[field])])),
    })),
  });
}

export function restoreRecheckedMapping(mapping: InvoiceMapping, originalMapping: InvoiceMapping, fields: string[]) {
  const originalIds = new Map(mappedEvidenceFields(originalMapping).map(({ field, id }) => [field, id ?? null]));
  return replaceMappedEvidence(mapping, new Map(fields.map((field) => [field, originalIds.get(field) ?? null])));
}

export function validateMapping(mapping: InvoiceMapping, evidence: SourceRef[]) {
  const known = new Set(evidence.map((source) => source.id));
  const unknownIds = [...new Set(mappedEvidenceFields(mapping).flatMap(({ id }) => (id && !known.has(id) ? [id] : [])))];
  if (unknownIds.length) {
    throw new ProviderError("MAPPING_VALIDATION", "Mapper referenced unknown evidence.", {
      evidenceCount: evidence.length,
      unknownIds: unknownIds.slice(0, 10).join(", "),
      malformed: true,
    });
  }
}

export function preferReliableEvidence(mapping: InvoiceMapping, evidence: SourceRef[]): InvoiceMapping {
  const byId = new Map(evidence.map((source) => [source.id, source]));
  const replace = (id: string | null | undefined) => {
    if (!id) return id ?? null;
    const selected = byId.get(id);
    if (!selected || selected.confidence === null || selected.confidence >= 0.75) return id;
    const content = selected.content.normalize("NFKC").trim();
    const candidates = evidence
      .filter(
        (candidate) =>
          candidate.id !== id &&
          candidate.content.normalize("NFKC").trim() === content &&
          candidate.confidence !== null &&
          candidate.confidence >= 0.75,
      )
      .sort((left, right) => evidencePriority(left) - evidencePriority(right) || left.id.localeCompare(right.id));
    const bestPriority = candidates[0] ? evidencePriority(candidates[0]) : null;
    const best = candidates.filter((candidate) => evidencePriority(candidate) === bestPriority);
    return best.length === 1 ? best[0]!.id : id;
  };
  return replaceMappedEvidence(
    mapping,
    new Map(mappedEvidenceFields(mapping).map(({ field, id }) => [field, replace(id)])),
  );
}

function evidencePriority(source: SourceRef) {
  return (
    {
      FIELD: 0,
      ITEM: 0,
      TAX: 0,
      KEY_VALUE: 1,
      TABLE: 2,
      OCR_LINE: 3,
      RECORDED: 4,
      AI_RECHECK: 0,
    }[source.sourceKind ?? "RECORDED"] ?? 4
  );
}

export function needsFullDocumentFallback(mapping: InvoiceMapping) {
  return (
    [mapping.vendor, mapping.invoiceNumber, mapping.invoiceDate, mapping.poNumber, mapping.currency, mapping.total].some((id) => !id) ||
    !mapping.lines.length ||
    mapping.lines.some((line) => (!line.sku && !line.description) || !line.quantity || !line.unitPrice || !line.amount)
  );
}

export function fullDocumentTargets(mapping: InvoiceMapping, extracted: InvoiceExtraction | null) {
  const requiredHeaders = new Set<keyof InvoiceMapping>(["vendor", "invoiceNumber", "invoiceDate", "total"]);
  const targets: Array<{ field: string; id: string | null | undefined }> = [];
  for (const field of mappingHeaderFields) {
    if (mapping[field]) continue;
    if (requiredHeaders.has(field) || extracted?.[field]?.trim()) targets.push({ field, id: null });
  }
  const lineCount = Math.max(mapping.lines.length, extracted?.lines.length ?? 0);
  for (let index = 0; index < lineCount; index += 1) {
    const existing = mapping.lines[index];
    const reread = extracted?.lines[index];
    for (const field of mappingLineFields) {
      if (!existing?.[field] && reread?.[field]?.trim()) targets.push({ field: `lines.${index}.${field}`, id: existing?.[field] ?? null });
    }
    const hasIdentity = Boolean(existing?.sku || existing?.description || reread?.sku?.trim() || reread?.description?.trim());
    if (!hasIdentity) targets.push({ field: `lines.${index}.identity`, id: null });
    const arithmetic = ["quantity", "unitPrice", "amount"] as const;
    const available = arithmetic.filter((field) => existing?.[field] || reread?.[field]?.trim());
    if (available.length < 2)
      for (const field of arithmetic)
        if (!existing?.[field] && !reread?.[field]?.trim()) targets.push({ field: `lines.${index}.${field}`, id: null });
  }
  if (!lineCount) targets.push({ field: "lines", id: null });
  return targets;
}

export function mergeFullDocumentMapping(mapping: InvoiceMapping, extracted: InvoiceExtraction | null, replacements: Map<string, string>) {
  if (!extracted) return mapping;
  const lineCount = Math.max(mapping.lines.length, extracted.lines.length);
  return replaceMappedEvidence(
    invoiceMappingSchema.parse({
      ...mapping,
      lines: Array.from(
        { length: lineCount },
        (_, index) => mapping.lines[index] ?? Object.fromEntries(mappingLineFields.map((field) => [field, null])),
      ),
    }),
    replacements,
  );
}

export function extractedValueFields(extraction: InvoiceExtraction) {
  return [
    ...mappingHeaderFields.map((field) => ({ field, value: extraction[field] })),
    ...extraction.lines.flatMap((line, index) =>
      mappingLineFields.map((field) => ({ field: `lines.${index}.${field}`, value: line[field] })),
    ),
  ];
}

export function completeInvoiceExtraction(extraction: InvoiceExtraction) {
  const requiredHeaders = [extraction.vendor, extraction.invoiceNumber, extraction.invoiceDate, extraction.total];
  return (
    requiredHeaders.every((value) => Boolean(value?.trim())) &&
    extraction.lines.length > 0 &&
    extraction.lines.every(
      (line) =>
        Boolean((line.sku || line.description)?.trim()) &&
        [line.quantity, line.unitPrice, line.amount].filter((value) => Boolean(value?.trim())).length >= 2,
    )
  );
}
