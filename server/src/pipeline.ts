import { evaluateHappyPath, normalizeInvoice } from "./controls.js";
import { extractAndMapRecorded } from "./providers.js";
import type { Storage } from "./storage.js";

export async function processInvoice(runId: string, storage: Storage) {
  const current = storage.getRun(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  if (current.state === "POSTED") return current;
  if (current.state !== "PROCESSING") throw new Error("INVALID_RUN_STATE");

  storage.addStage(runId, "EXTRACTION", "ACTIVE");
  const { evidence, mapping } = await extractAndMapRecorded();
  storage.saveEvidence(runId, evidence);
  storage.addStage(runId, "EXTRACTION", "COMPLETED");
  storage.addStage(runId, "MAPPING", "COMPLETED");

  const invoice = normalizeInvoice(evidence, mapping);
  storage.addStage(runId, "NORMALIZATION", "COMPLETED");
  const evaluation = evaluateHappyPath(invoice, storage.getHappyContext());
  storage.addStage(runId, "CONTROLS", "COMPLETED");
  storage.post(runId, invoice, evaluation.checks, evaluation.allocations);
  storage.addStage(runId, "POSTING", "COMPLETED");
  return storage.getRun(runId)!;
}
