import { ControlError, evaluateConfirmedBundle, evaluateDuplicate, evaluateInvoice } from "./controls.js";
import { buildInvoicePreview, NormalizationError, normalizeInvoice } from "./invoice-normalization.js";
import { readFile } from "node:fs/promises";
import { extractAndMap, logProviderError, providerFailureReason, restoreRecheckedMapping } from "./providers.js";
import type { InvoiceMapping } from "./providers.js";
import type { Storage } from "./storage.js";
import type { Allocation, CheckResult } from "../../shared/contracts.js";

export async function processInvoice(runId: string, storage: Storage) {
  // Resume only runs that are still in the normal processing state.
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state === "POSTED" || current.state === "NEEDS_REVIEW") return current;
  if (current.state !== "PROCESSING") throw new Error("INVALID_RUN_STATE");

  // 1. Read the PDF and use the configured provider to extract evidence and map fields.
  storage.addStage(runId, "EXTRACTION", "ACTIVE");
  const pdfPath = storage.getPdfPath(runId);
  if (!pdfPath) throw new Error("RUN_DOCUMENT_NOT_FOUND");
  let providerResult;
  try {
    providerResult = await extractAndMap(await readFile(pdfPath));
  } catch (caught) {
    logProviderError(caught);
    const reason = providerFailureReason(caught);
    storage.addStage(runId, reason === "MAPPING_FAILED" ? "MAPPING" : "EXTRACTION", "FAILED");
    storage.block(runId, reason, nextActionFor(reason));
    return storage.getRun(runId)!;
  }
  const { evidence, mapping, originalMapping, aiRechecks } = providerResult;
  storage.saveEvidence(runId, evidence);
  storage.saveAiRechecks(runId, aiRechecks);
  storage.addStage(runId, "EXTRACTION", "COMPLETED");
  storage.addStage(runId, "MAPPING", "COMPLETED");

  let invoice;
  // activeMapping is the AI mapping
  let activeMapping = mapping;
  let activeRechecks = aiRechecks;

  // 2. Convert provider output into the validated internal invoice model.
  // If an AI recheck made a field worse, restore the original mapping and flag it.
  try {
    for (;;) {
      try {
        // Convert to apps invoice format
        invoice = normalizeInvoice(evidence, activeMapping);
        break;
      } catch (caught) {
        // If fail, restore original values for the invalid fields and recheck
        const invalidFields = invalidRecheckFields(caught, activeRechecks);
        if (!invalidFields.length) throw caught;
        activeMapping = restoreRecheckedMapping(activeMapping, originalMapping, invalidFields);
        activeRechecks = activeRechecks.map((recheck) =>
          invalidFields.includes(recheck.field) ? { ...recheck, outcome: "needs_review" as const } : recheck,
        );
        storage.saveAiRechecks(runId, activeRechecks);
      }
    }
  } catch (caught) {
    storage.addStage(runId, "NORMALIZATION", "FAILED");
    const reason = caught instanceof NormalizationError ? caught.reasonCode : "MAPPING_FAILED";
    const field = caught instanceof NormalizationError ? (caught.field ?? null) : null;
    const fields = caught instanceof NormalizationError && caught.fields.length ? caught.fields : field ? [field] : [];
    storage.block(
      runId,
      reason,
      nextActionFor(reason),
      null,
      fields.length
        ? fields.map((failedField) => {
            const fieldName = formatField(failedField);
            const ambiguousDate = reason === "AMBIGUOUS_DATE";
            const missingField = reason === "MISSING_REQUIRED_FIELD";
            return {
              code: ambiguousDate ? "AMBIGUOUS_DATE" : missingField ? "MISSING_REQUIRED_FIELD" : "LOW_CONFIDENCE",
              passed: false,
              detail: ambiguousDate
                ? `${fieldName} has an ambiguous numeric date format.`
                : missingField
                  ? `${fieldName} could not be extracted reliably.`
                  : `${fieldName} could not be read reliably.`,
              expected: ambiguousDate
                ? "An unambiguous invoice date"
                : missingField
                  ? `A readable ${fieldName.toLowerCase()}`
                  : `A readable ${fieldName.toLowerCase()}`,
              actual: ambiguousDate ? "Ambiguous numeric date" : missingField ? "Not extracted" : "Low-confidence scan",
              category: "IDENTITY",
              sourceIds: [sourceIdForField(activeMapping, failedField)].filter((id): id is string => Boolean(id)),
            };
          })
        : [
            {
              code: reason,
              passed: false,
              detail: nextActionFor(reason),
              expected: null,
              actual: null,
              sourceIds: [],
            },
          ],
      {
        invoicePreview: buildInvoicePreview(evidence, activeMapping, reason === "MISSING_REQUIRED_FIELD" ? (fields[0] ?? null) : null),
      },
    );
    return storage.getRun(runId)!;
  }
  storage.addStage(runId, "NORMALIZATION", "COMPLETED");

  if (duplicatePreflight(runId, storage, invoice, "CONTROLS")) return storage.getRun(runId)!;

  // 3. Run deterministic AP controls against the vendor, PO, lines, prices, and totals.
  let evaluation;
  try {
    evaluation = evaluateInvoice(invoice, storage.getControlContext());
  } catch (caught) {
    if (!(caught instanceof ControlError)) throw caught;
    if (caught.code === "MISSING_PO") {
      const candidates = storage.findPoCandidates(invoice);
      if (candidates.length) {
        storage.awaitPoConfirmation(runId, invoice, caught.checks, candidates, nextActionFor("MISSING_PO"));
        return storage.getRun(runId)!;
      }
    }
    if (caught.code === "LINE_MATCH") {
      const candidates = storage.findBundleCandidates(invoice);
      if (candidates.length) {
        storage.addStage(runId, "CONTROLS", "COMPLETED");
        storage.awaitBundleConfirmation(runId, invoice, caught.checks, candidates, nextActionFor("BUNDLE_MAPPING_REQUIRED"));
        return storage.getRun(runId)!;
      }
    }
    storage.addStage(runId, "CONTROLS", "FAILED");
    const poCandidates = invoice.poNumber
      ? storage.findPoCandidates(invoice, true).filter((candidate) => candidate.poNumber === invoice.poNumber)
      : [];
    return blockForControlError(runId, storage, invoice, caught, poCandidates);
  }
  storage.addStage(runId, "CONTROLS", "COMPLETED");

  // 4. Post the invoice and its line-to-PO allocations atomically.
  try {
    storage.post(runId, invoice, evaluation.checks, evaluation.allocations);
  } catch (caught) {
    storage.addStage(runId, "POSTING", "FAILED");
    const reason =
      caught instanceof Error && caught.message === "DUPLICATE"
        ? "DUPLICATE"
        : caught instanceof Error && caught.message === "CAPACITY_CHANGED"
          ? "PO_CAPACITY_EXCEEDED"
          : "PROCESSING_ERROR";
    storage.block(runId, reason, nextActionFor(reason), invoice, evaluation.checks);
    return storage.getRun(runId)!;
  }
  storage.addStage(runId, "POSTING", "COMPLETED");
  return storage.getRun(runId)!;
}

function duplicatePreflight(
  runId: string,
  storage: Storage,
  invoice: import("../../shared/contracts.js").NormalizedInvoice,
  failedStage?: string,
) {
  const duplicate = evaluateDuplicate(invoice, storage.getControlContext());
  if (duplicate.check.passed || !duplicate.vendor) return false;
  if (failedStage) storage.addStage(runId, failedStage, "FAILED");
  storage.block(runId, "DUPLICATE", nextActionFor("DUPLICATE"), invoice, [duplicate.check], {
    duplicateMatch: storage.findDuplicate(duplicate.vendor.id, invoice.invoiceNumber),
  });
  return true;
}

function blockForControlError(
  runId: string,
  storage: Storage,
  invoice: import("../../shared/contracts.js").NormalizedInvoice,
  error: ControlError,
  poCandidates: import("../../shared/contracts.js").PoCandidate[] = [],
) {
  const reason = reasonFor(error.code);
  storage.block(runId, reason, nextActionFor(reason), invoice, error.checks, {
    poCandidates,
  });
  return storage.getRun(runId)!;
}

function invalidRecheckFields(caught: unknown, rechecks: import("../../shared/contracts.js").AiRecheck[]) {
  if (!(caught instanceof NormalizationError)) return [];
  const failed = new Set([caught.field, ...caught.fields].filter((field): field is string => Boolean(field)).map(normalizationFieldFor));
  return rechecks.filter((recheck) => recheck.outcome === "resolved" && failed.has(recheck.field)).map((recheck) => recheck.field);
}

function normalizationFieldFor(field: string) {
  return field
    .replace(/\.observedUnitPrice$/, ".unitPrice")
    .replace(/\.observedAmount$/, ".amount")
    .replace(/\.observedTaxAmount$/, ".taxAmount");
}

function sourceIdForField(mapping: InvoiceMapping, field: string) {
  const headers: Record<string, string | null | undefined> = {
    vendor: mapping.vendor,
    invoiceNumber: mapping.invoiceNumber,
    invoiceDate: mapping.invoiceDate,
    poNumber: mapping.poNumber,
    currency: mapping.currency,
    observedSubtotal: mapping.subtotal,
    observedTax: mapping.tax,
    observedTotal: mapping.total,
    taxNote: mapping.taxNote,
  };
  if (field in headers) return headers[field] ?? null;

  const lineField = field.match(/^lines\.(\d+)\.(.+)$/);
  if (!lineField) return null;
  const line = mapping.lines[Number(lineField[1])];
  const value = line?.[lineField[2] as keyof typeof line];
  return typeof value === "string" ? value : null;
}

export function confirmPo(runId: string, storage: Storage, poNumber: string) {
  // Re-run controls after the reviewer supplies the missing PO number.
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state === "POSTED") return current;
  if (current.state !== "AWAITING_PO_CONFIRMATION") throw new Error("INVALID_RUN_STATE");
  if (!storage.getPoCandidates(runId).some((row) => row.poNumber === poNumber)) throw new Error("INVALID_CONFIRMATION");
  const invoice = storage.getEvaluation(runId)?.invoice;
  if (!invoice) throw new Error("RUN_EVALUATION_NOT_FOUND");
  const confirmedInvoice = { ...invoice, poNumber };
  let evaluation;
  try {
    if (duplicatePreflight(runId, storage, confirmedInvoice)) return storage.getRun(runId)!;
    evaluation = evaluateInvoice(confirmedInvoice, storage.getControlContext());
  } catch (caught) {
    if (!(caught instanceof ControlError)) throw caught;
    if (caught.code === "LINE_MATCH") {
      const candidates = storage.findBundleCandidates(confirmedInvoice);
      if (candidates.length) {
        storage.addStage(runId, "CONFIRMATION", "COMPLETED");
        storage.awaitBundleConfirmation(runId, confirmedInvoice, caught.checks, candidates, nextActionFor("BUNDLE_MAPPING_REQUIRED"));
        return storage.getRun(runId)!;
      }
    }
    return blockForControlError(runId, storage, confirmedInvoice, caught);
  }
  storage.addStage(runId, "CONFIRMATION", "COMPLETED");
  storage.post(runId, confirmedInvoice, evaluation.checks, evaluation.allocations);
  storage.addStage(runId, "POSTING", "COMPLETED");
  return storage.getRun(runId)!;
}

export function rejectPo(runId: string, storage: Storage) {
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state !== "AWAITING_PO_CONFIRMATION") throw new Error("INVALID_RUN_STATE");
  const evaluation = storage.getEvaluation(runId);
  if (!evaluation?.invoice) throw new Error("RUN_EVALUATION_NOT_FOUND");
  storage.block(
    runId,
    "MISSING_PO",
    "Correct the invoice PO reference or route it through the manual AP process.",
    evaluation.invoice,
    evaluation.checks,
  );
  return storage.getRun(runId)!;
}

export function confirmBundle(runId: string, storage: Storage, candidateId: string) {
  // Turn the reviewer-selected bundle decomposition into final allocations.
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state === "POSTED") return current;
  if (current.state !== "AWAITING_BUNDLE_CONFIRMATION") throw new Error("INVALID_RUN_STATE");
  const candidate = storage.getBundleCandidates(runId).find((row) => row.id === candidateId);
  if (!candidate) throw new Error("INVALID_CONFIRMATION");
  const invoice = storage.getEvaluation(runId)?.invoice;
  if (!invoice) throw new Error("RUN_EVALUATION_NOT_FOUND");
  if (duplicatePreflight(runId, storage, invoice)) return storage.getRun(runId)!;
  let evaluation: { checks: CheckResult[]; allocations: Allocation[] };
  try {
    evaluation = evaluateConfirmedBundle(invoice, candidate, storage.getControlContext());
  } catch (caught) {
    if (!(caught instanceof ControlError)) throw caught;
    return blockForControlError(runId, storage, invoice, caught);
  }
  storage.addStage(runId, "CONFIRMATION", "COMPLETED");
  storage.post(runId, invoice, evaluation.checks, evaluation.allocations);
  storage.addStage(runId, "POSTING", "COMPLETED");
  return storage.getRun(runId)!;
}

export function rejectBundle(runId: string, storage: Storage) {
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state !== "AWAITING_BUNDLE_CONFIRMATION") throw new Error("INVALID_RUN_STATE");
  const evaluation = storage.getEvaluation(runId);
  if (!evaluation?.invoice) throw new Error("RUN_EVALUATION_NOT_FOUND");
  storage.block(
    runId,
    "BUNDLE_MAPPING_REQUIRED",
    "The proposed decomposition was rejected. Route this invoice for manual AP review.",
    evaluation.invoice,
    evaluation.checks,
    { bundleCandidates: storage.getBundleCandidates(runId) },
  );
  return storage.getRun(runId)!;
}

function reasonFor(checkCode: string) {
  if (checkCode === "MULTIPLE_ISSUES") return "MULTIPLE_ISSUES";
  if (["UNSUPPORTED_STRUCTURE"].includes(checkCode)) return "UNSUPPORTED_STRUCTURE";
  if (["TAX_BASIS"].includes(checkCode)) return "TAX_TREATMENT_UNRESOLVED";
  if (checkCode === "DUPLICATE") return "DUPLICATE";
  if (["VENDOR_MATCH", "PO_ELIGIBLE"].includes(checkCode)) return "VENDOR_OR_PO_MISMATCH";
  if (checkCode === "LINE_MATCH") return "LINE_MATCH_FAILED";
  if (checkCode === "PRICE_MATCH") return "PRICE_VARIANCE_EXCEEDED";
  if (checkCode === "RECEIPT_CAPACITY") return "RECEIPT_CAPACITY_EXCEEDED";
  if (checkCode === "ORDERED_CAPACITY") return "PO_CAPACITY_EXCEEDED";
  return "TOTAL_MISMATCH";
}

function nextActionFor(reasonCode: string) {
  return (
    {
      DOCUMENT_UNREADABLE: "Upload a valid, unencrypted PDF within the size and page limits.",
      EXTRACTION_FAILED: "Retry once; if it repeats, verify service configuration or use a clearer PDF.",
      LOW_CONFIDENCE: "Verify the highlighted field in the source document; this demo does not support overrides.",
      MAPPING_FAILED: "Inspect the extracted evidence and retry; no values were assumed.",
      MISSING_REQUIRED_FIELD:
        "Review the highlighted field in the source document; correct the document only if the value is truly absent.",
      AMBIGUOUS_DATE: "Confirm whether the invoice date is day-month or month-day, then provide an unambiguous date.",
      TAX_TREATMENT_UNRESOLVED: "Provide explicit tax treatment and rate evidence or route the invoice for manual tax review.",
      VENDOR_OR_PO_MISMATCH: "Verify the vendor and PO reference in the source system.",
      MISSING_PO: "Confirm one of the stored candidates, or correct the invoice when no candidate exists.",
      BUNDLE_MAPPING_REQUIRED:
        "Confirm a stored decomposition when offered; otherwise provide trusted bundle master data or an itemized invoice.",
      LINE_MATCH_FAILED: "Verify SKU, description, and UOM; manual remapping is out of scope.",
      DUPLICATE: "Review the existing ledger invoice; do not repost.",
      RECEIPT_CAPACITY_EXCEEDED: "Record or correct the goods receipt before retrying.",
      PO_CAPACITY_EXCEEDED: "Amend the PO or correct the invoice before retrying.",
      PRICE_VARIANCE_EXCEEDED: "Review the invoice price against the PO or bundle definition.",
      MULTIPLE_ISSUES: "Resolve every failed control before submitting this invoice again.",
      TOTAL_MISMATCH: "Review the current line items and totals for an omitted, duplicated, or inconsistent charge.",
      UNSUPPORTED_STRUCTURE: "Route it to the normal manual AP process.",
      PROCESSING_ERROR: "Retry; if it repeats, inspect application diagnostics without reposting.",
    }[reasonCode] ?? "Review the invoice and purchase-order evidence."
  );
}

function formatField(field: string) {
  const labels: Record<string, string> = {
    vendor: "Vendor",
    invoiceNumber: "Invoice number",
    invoiceDate: "Invoice date",
    currency: "Currency",
    observedTotal: "Invoice total",
    observedUnitPrice: "Unit price",
    quantity: "Line quantity",
    uom: "Unit of measure",
  };
  const normalized = field.replace(/^lines\.\d+\./, "");
  if (normalized === "identity") return "Line item SKU or description";
  return labels[normalized] ?? normalized.replace(/([A-Z])/g, " $1").trim();
}
