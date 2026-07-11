import {
  ControlError,
  evaluateHappyPath,
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
    storage.block(
      runId,
      reason,
      nextActionFor(reason),
    );
    return storage.getRun(runId)!;
  }
  const { evidence, mapping } = providerResult;
  storage.saveEvidence(runId, evidence);
  storage.addStage(runId, "EXTRACTION", "COMPLETED");
  storage.addStage(runId, "MAPPING", "COMPLETED");

  let invoice;
  try {
    invoice = normalizeInvoice(evidence, mapping);
  } catch {
    storage.addStage(runId, "NORMALIZATION", "FAILED");
    storage.block(
      runId,
      "MAPPING_FAILED",
      nextActionFor("MAPPING_FAILED"),
    );
    return storage.getRun(runId)!;
  }
  storage.addStage(runId, "NORMALIZATION", "COMPLETED");
  if (!invoice.poNumber) {
    const candidatePo = storage.findPoCandidate(invoice);
    if (candidatePo) {
      storage.awaitPoConfirmation(
        runId,
        invoice,
        [{ code: "MISSING_PO", passed: false, detail: "Invoice omitted its PO reference." }],
        candidatePo,
        nextActionFor("MISSING_PO"),
      );
      return storage.getRun(runId)!;
    }
  }
  let evaluation;
  try {
    evaluation = evaluateHappyPath(invoice, storage.getHappyContext());
  } catch (caught) {
    if (!(caught instanceof ControlError)) throw caught;
    if (caught.code === "LINE_MATCH") {
      const candidate = storage.findBundleCandidate(invoice);
      if (candidate) {
        storage.addStage(runId, "CONTROLS", "COMPLETED");
        storage.awaitBundleConfirmation(
          runId,
          invoice,
          caught.checks,
          candidate,
          nextActionFor("BUNDLE_MAPPING_REQUIRED"),
        );
        return storage.getRun(runId)!;
      }
    }
    storage.addStage(runId, "CONTROLS", "FAILED");
    storage.block(
      runId,
      reasonFor(caught.code),
      nextActionFor(reasonFor(caught.code)),
      invoice,
      caught.checks,
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
  const evaluation = evaluateHappyPath(confirmedInvoice, storage.getHappyContext());
  storage.addStage(runId, "CONFIRMATION", "COMPLETED");
  storage.post(runId, confirmedInvoice, evaluation.checks, evaluation.allocations);
  storage.addStage(runId, "POSTING", "COMPLETED");
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
  const checks: CheckResult[] = [
    { code: "BUNDLE_MAPPING_CONFIRMED", passed: true, detail: "Reviewer confirmed the stored bundle decomposition." },
  ];
  const allocations: Allocation[] = candidate.components.map((component) => ({
    invoiceLineIndex: candidate.invoiceLineIndex,
    poLineId: component.poLineId,
    poNumber: invoice.poNumber,
    sku: component.sku,
    quantity: component.quantity,
    matchType: "BUNDLE_CONFIRMED",
    bundleDefinitionId: null,
    poBasisAmount: component.poBasisAmount,
    actualNetAmount: component.poBasisAmount,
    remainingOrderedQuantity: "0",
    remainingReceivedQuantity: "0",
  }));
  storage.addStage(runId, "CONFIRMATION", "COMPLETED");
  storage.post(runId, invoice, checks, allocations);
  storage.addStage(runId, "POSTING", "COMPLETED");
  return storage.getRun(runId)!;
}

function reasonFor(checkCode: string) {
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
      PO_CAPACITY_EXCEEDED: "Amend the PO or correct the invoice before retrying.",
      PRICE_VARIANCE_EXCEEDED:
        "Review the invoice price against the PO or bundle definition.",
      TOTAL_MISMATCH: "Correct the invoice arithmetic.",
      UNSUPPORTED_STRUCTURE: "Route it to the normal manual AP process.",
      PROCESSING_ERROR:
        "Retry; if it repeats, inspect application diagnostics without reposting.",
    }[reasonCode] ?? "Review the invoice and purchase-order evidence."
  );
}
