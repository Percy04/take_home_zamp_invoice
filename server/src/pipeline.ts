import {
  ControlError,
  buildInvoicePreview,
  evaluateConfirmedBundle,
  evaluateHappyPath,
  NormalizationError,
  normalizeInvoice,
} from "./controls.js";
import { readFile } from "node:fs/promises";
import {
  extractAndMap,
  logProviderError,
  providerFailureReason,
} from "./providers.js";
import type { Storage } from "./storage.js";
import type { Allocation, CheckResult } from "../../shared/contracts.js";

export async function processInvoice(runId: string, storage: Storage) {
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state === "POSTED" || current.state === "NEEDS_REVIEW")
    return current;
  if (current.state !== "PROCESSING") throw new Error("INVALID_RUN_STATE");

  storage.addStage(runId, "EXTRACTION", "ACTIVE");
  const pdfPath = storage.getPdfPath(runId);
  if (!pdfPath) throw new Error("RUN_DOCUMENT_NOT_FOUND");
  let providerResult;
  try {
    providerResult = await extractAndMap(await readFile(pdfPath));
  } catch (caught) {
    logProviderError(caught);
    const reason = providerFailureReason(caught);
    storage.addStage(
      runId,
      reason === "MAPPING_FAILED" ? "MAPPING" : "EXTRACTION",
      "FAILED",
    );
    storage.block(runId, reason, nextActionFor(reason));
    return storage.getRun(runId)!;
  }
  const { evidence, mapping } = providerResult;
  storage.saveEvidence(runId, evidence);
  storage.addStage(runId, "EXTRACTION", "COMPLETED");
  storage.addStage(runId, "MAPPING", "COMPLETED");

  let invoice;
  try {
    invoice = normalizeInvoice(evidence, mapping);
  } catch (caught) {
    storage.addStage(runId, "NORMALIZATION", "FAILED");
    const reason =
      caught instanceof NormalizationError
        ? caught.reasonCode
        : "MAPPING_FAILED";
    const field =
      caught instanceof NormalizationError ? (caught.field ?? null) : null;
    const fields =
      caught instanceof NormalizationError && caught.fields.length
        ? caught.fields
        : field
          ? [field]
          : [];
    storage.block(
      runId,
      reason,
      nextActionFor(reason),
      null,
      fields.length
        ? fields.map((failedField) => {
            const fieldName = formatField(failedField);
            return {
              code: "LOW_CONFIDENCE",
              passed: false,
              detail: `${fieldName} could not be read reliably.`,
              expected: `A readable ${fieldName.toLowerCase()}`,
              actual: "Low-confidence scan",
              sourceIds: [],
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
        invoicePreview: buildInvoicePreview(evidence, mapping, fields[0] ?? null),
      },
    );
    return storage.getRun(runId)!;
  }
  storage.addStage(runId, "NORMALIZATION", "COMPLETED");
  const duplicateMatch = storage.findDuplicate(invoice);
  if (duplicateMatch) {
    const checks: CheckResult[] = [
      {
        code: "DUPLICATE",
        passed: false,
        detail: "Invoice number has already been posted for this vendor.",
        category: "DUPLICATE",
        expected: "A new invoice number for this vendor",
        actual: invoice.invoiceNumber,
        sourceIds: [invoice.fieldSources.invoiceNumber].filter(Boolean),
      },
    ];
    storage.addStage(runId, "CONTROLS", "FAILED");
    storage.block(
      runId,
      "DUPLICATE",
      nextActionFor("DUPLICATE"),
      invoice,
      checks,
      { duplicateMatch },
    );
    return storage.getRun(runId)!;
  }
  if (!invoice.poNumber) {
    const candidates = storage.findPoCandidates(invoice);
    if (candidates.length) {
      storage.awaitPoConfirmation(
        runId,
        invoice,
        [
          {
            code: "MISSING_PO",
            passed: false,
            detail: "Invoice omitted its PO reference.",
          },
        ],
        candidates,
        nextActionFor("MISSING_PO"),
      );
      return storage.getRun(runId)!;
    }
    storage.block(runId, "MISSING_PO", nextActionFor("MISSING_PO"), invoice, [
      {
        code: "MISSING_PO",
        passed: false,
        detail:
          "Invoice omitted its PO reference and no candidate is available.",
      },
    ]);
    return storage.getRun(runId)!;
  }
  let evaluation;
  try {
    evaluation = evaluateHappyPath(invoice, storage.getHappyContext());
  } catch (caught) {
    if (!(caught instanceof ControlError)) throw caught;
    if (caught.code === "LINE_MATCH") {
      const candidates = storage.findBundleCandidates(invoice);
      if (candidates.length) {
        storage.addStage(runId, "CONTROLS", "COMPLETED");
        storage.awaitBundleConfirmation(
          runId,
          invoice,
          caught.checks,
          candidates,
          nextActionFor("BUNDLE_MAPPING_REQUIRED"),
        );
        return storage.getRun(runId)!;
      }
    }
    storage.addStage(runId, "CONTROLS", "FAILED");
    const poCandidates = invoice.poNumber
      ? storage
          .findPoCandidates(invoice, true)
          .filter((candidate) => candidate.poNumber === invoice.poNumber)
      : [];
    storage.block(
      runId,
      reasonFor(caught.code),
      nextActionFor(reasonFor(caught.code)),
      invoice,
      caught.checks,
      { poCandidates },
    );
    return storage.getRun(runId)!;
  }
  storage.addStage(runId, "CONTROLS", "COMPLETED");
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
    storage.block(
      runId,
      reason,
      nextActionFor(reason),
      invoice,
      evaluation.checks,
    );
    return storage.getRun(runId)!;
  }
  storage.addStage(runId, "POSTING", "COMPLETED");
  return storage.getRun(runId)!;
}

export function confirmPo(runId: string, storage: Storage, poNumber: string) {
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state === "POSTED") return current;
  if (current.state !== "AWAITING_PO_CONFIRMATION")
    throw new Error("INVALID_RUN_STATE");
  if (!storage.getPoCandidates(runId).some((row) => row.poNumber === poNumber))
    throw new Error("INVALID_CONFIRMATION");
  const invoice = storage.getEvaluation(runId)?.invoice;
  if (!invoice) throw new Error("RUN_EVALUATION_NOT_FOUND");
  const confirmedInvoice = { ...invoice, poNumber };
  let evaluation;
  try {
    evaluation = evaluateHappyPath(confirmedInvoice, storage.getHappyContext());
  } catch (caught) {
    if (!(caught instanceof ControlError)) throw caught;
    if (caught.code === "LINE_MATCH") {
      const candidates = storage.findBundleCandidates(confirmedInvoice);
      if (candidates.length) {
        storage.addStage(runId, "CONFIRMATION", "COMPLETED");
        storage.awaitBundleConfirmation(
          runId,
          confirmedInvoice,
          caught.checks,
          candidates,
          nextActionFor("BUNDLE_MAPPING_REQUIRED"),
        );
        return storage.getRun(runId)!;
      }
    }
    const reason = reasonFor(caught.code);
    storage.block(
      runId,
      reason,
      nextActionFor(reason),
      confirmedInvoice,
      caught.checks,
    );
    return storage.getRun(runId)!;
  }
  storage.addStage(runId, "CONFIRMATION", "COMPLETED");
  storage.post(
    runId,
    confirmedInvoice,
    evaluation.checks,
    evaluation.allocations,
  );
  storage.addStage(runId, "POSTING", "COMPLETED");
  return storage.getRun(runId)!;
}

export function rejectPo(runId: string, storage: Storage) {
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state !== "AWAITING_PO_CONFIRMATION")
    throw new Error("INVALID_RUN_STATE");
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

export function confirmBundle(
  runId: string,
  storage: Storage,
  candidateId: string,
) {
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state === "POSTED") return current;
  if (current.state !== "AWAITING_BUNDLE_CONFIRMATION")
    throw new Error("INVALID_RUN_STATE");
  const candidate = storage
    .getBundleCandidates(runId)
    .find((row) => row.id === candidateId);
  if (!candidate) throw new Error("INVALID_CONFIRMATION");
  const invoice = storage.getEvaluation(runId)?.invoice;
  if (!invoice) throw new Error("RUN_EVALUATION_NOT_FOUND");
  let evaluation: { checks: CheckResult[]; allocations: Allocation[] };
  try {
    evaluation = evaluateConfirmedBundle(
      invoice,
      candidate,
      storage.getHappyContext(),
    );
  } catch (caught) {
    if (!(caught instanceof ControlError)) throw caught;
    const reason = reasonFor(caught.code);
    storage.block(runId, reason, nextActionFor(reason), invoice, caught.checks);
    return storage.getRun(runId)!;
  }
  storage.addStage(runId, "CONFIRMATION", "COMPLETED");
  storage.post(runId, invoice, evaluation.checks, evaluation.allocations);
  storage.addStage(runId, "POSTING", "COMPLETED");
  return storage.getRun(runId)!;
}

export function rejectBundle(runId: string, storage: Storage) {
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state !== "AWAITING_BUNDLE_CONFIRMATION")
    throw new Error("INVALID_RUN_STATE");
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
  if (["UNSUPPORTED_STRUCTURE"].includes(checkCode))
    return "UNSUPPORTED_STRUCTURE";
  if (["TAX_BASIS"].includes(checkCode)) return "TAX_TREATMENT_UNRESOLVED";
  if (checkCode === "DUPLICATE") return "DUPLICATE";
  if (["VENDOR_MATCH", "PO_ELIGIBLE"].includes(checkCode))
    return "VENDOR_OR_PO_MISMATCH";
  if (checkCode === "LINE_MATCH") return "LINE_MATCH_FAILED";
  if (checkCode === "PRICE_MATCH") return "PRICE_VARIANCE_EXCEEDED";
  if (checkCode === "RECEIPT_CAPACITY") return "RECEIPT_CAPACITY_EXCEEDED";
  if (checkCode === "ORDERED_CAPACITY") return "PO_CAPACITY_EXCEEDED";
  return "TOTAL_MISMATCH";
}

function nextActionFor(reasonCode: string) {
  return (
    {
      DOCUMENT_UNREADABLE:
        "Upload a valid, unencrypted PDF within the size and page limits.",
      EXTRACTION_FAILED:
        "Retry once; if it repeats, verify service configuration or use a clearer PDF.",
      LOW_CONFIDENCE:
        "Verify the highlighted field in the source document; this demo does not support overrides.",
      MAPPING_FAILED:
        "Inspect the extracted evidence and retry; no values were assumed.",
      MISSING_REQUIRED_FIELD:
        "Correct the invoice or provide a document containing the highlighted field.",
      TAX_TREATMENT_UNRESOLVED:
        "Provide explicit tax treatment and rate evidence or route the invoice for manual tax review.",
      VENDOR_OR_PO_MISMATCH:
        "Verify the vendor and PO reference in the source system.",
      MISSING_PO:
        "Confirm one of the stored candidates, or correct the invoice when no candidate exists.",
      BUNDLE_MAPPING_REQUIRED:
        "Confirm a stored decomposition when offered; otherwise provide trusted bundle master data or an itemized invoice.",
      LINE_MATCH_FAILED:
        "Verify SKU, description, and UOM; manual remapping is out of scope.",
      DUPLICATE: "Review the existing ledger invoice; do not repost.",
      RECEIPT_CAPACITY_EXCEEDED:
        "Record or correct the goods receipt before retrying.",
      PO_CAPACITY_EXCEEDED:
        "Amend the PO or correct the invoice before retrying.",
      PRICE_VARIANCE_EXCEEDED:
        "Review the invoice price against the PO or bundle definition.",
      MULTIPLE_ISSUES:
        "Resolve every failed control before submitting this invoice again.",
      TOTAL_MISMATCH: "Correct the invoice arithmetic.",
      UNSUPPORTED_STRUCTURE: "Route it to the normal manual AP process.",
      PROCESSING_ERROR:
        "Retry; if it repeats, inspect application diagnostics without reposting.",
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
