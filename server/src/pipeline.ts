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
      "Check provider configuration or review the document manually.",
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
      "Review the extracted invoice evidence manually.",
    );
    return storage.getRun(runId)!;
  }
  storage.addStage(runId, "NORMALIZATION", "COMPLETED");
  let evaluation;
  try {
    evaluation = evaluateHappyPath(invoice, storage.getHappyContext());
  } catch (caught) {
    if (!(caught instanceof ControlError)) throw caught;
    storage.addStage(runId, "CONTROLS", "FAILED");
    storage.block(
      runId,
      reasonFor(caught.code),
      "Review the invoice and purchase-order evidence.",
      invoice,
      caught.checks,
    );
    return storage.getRun(runId)!;
  }
  storage.addStage(runId, "CONTROLS", "COMPLETED");
  storage.post(runId, invoice, evaluation.checks, evaluation.allocations);
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
