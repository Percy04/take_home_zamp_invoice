import { runDetailSchema, runListSchema } from "../../../shared/contracts";
import { toUiRun, toUiSummary } from "./api-adapter";
import * as store from "./store";
import type { Run } from "./types";

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

export async function createRun(file: File): Promise<Run> {
  const body = new FormData();
  body.append("invoice", file);
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
