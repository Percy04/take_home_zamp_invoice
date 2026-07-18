import { runDetailSchema, runListSchema } from "../../../shared/contracts";
import { toUiRun, toUiSummary } from "./api-adapter";
import * as store from "./store";
import type { Run } from "./types";

export const sampleInvoices = [
  { id: "happy", label: "Happy", hint: "Direct PO match, auto-posted" },
  { id: "happy_layout_b", label: "Happy layout B", hint: "Different layout, same result" },
  { id: "happy_layout_c_scanned", label: "Scanned invoice", hint: "OCR extraction and review" },
  { id: "duplicate", label: "Duplicate", hint: "Already posted to ledger" },
  { id: "missing_po", label: "Missing PO", hint: "No PO on invoice, suggested match" },
  { id: "missing_po_bundle", label: "Missing PO bundle", hint: "Confirm PO, then validate bundle" },
  { id: "receipt_capacity", label: "Receipt capacity", hint: "Requested exceeds received" },
  { id: "multiple_issues", label: "Multiple issues", hint: "Price variance and receipt shortfall" },
  { id: "bundle_known", label: "Known bundle", hint: "Trusted bundle definition" },
  { id: "bundle_unknown", label: "Unknown bundle", hint: "Reviewer confirmation needed" },
  { id: "tax_inclusive", label: "Tax inclusive", hint: "Prices include tax, normalized" },
] as const;

export type SampleInvoiceId = (typeof sampleInvoices)[number]["id"];
export type ReviewAction =
  | { action: "confirm_po"; poNumber: string }
  | { action: "reject_po" }
  | { action: "confirm_bundle"; candidateId: string }
  | { action: "reject_bundle" };

async function requestRun(url: string, init?: RequestInit): Promise<Run> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? "The request failed.");
  }
  const run = toUiRun(runDetailSchema.parse(await response.json()));
  store.upsertRun(run);
  return run;
}

export async function createRun(input: { file?: File; fixtureId?: SampleInvoiceId }): Promise<Run> {
  if (Boolean(input.file) === Boolean(input.fixtureId)) throw new Error("Choose an invoice PDF or a prepared invoice.");
  const body = new FormData();
  if (input.file) body.append("invoice", input.file);
  else body.append("fixtureId", input.fixtureId!);
  const run = await requestRun("/api/runs", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body,
  });
  return run;
}

export async function listRuns(): Promise<Run[]> {
  const response = await fetch("/api/runs");
  if (!response.ok) throw new Error("Invoice activity could not be loaded.");
  const runs = runListSchema.parse(await response.json()).items.map(toUiSummary);
  store.replaceRuns(runs);
  return runs;
}

export async function getRun(runId: string): Promise<Run | undefined> {
  try {
    return await requestRun(`/api/runs/${runId}`);
  } catch {
    return undefined;
  }
}

export function reviewRun(runId: string, action: ReviewAction) {
  return requestRun(`/api/runs/${runId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
}

export async function resetWorkspace(): Promise<void> {
  const response = await fetch("/api/reset", { method: "POST" });
  if (!response.ok) throw new Error("The workspace could not be reset.");
  store.clearRuns();
}

export const documentUrl = (runId: string) => `/api/runs/${runId}/document`;
