import { runDetailSchema, type RunDetail } from "../../shared/contracts";

async function runRequest(url: string, init?: RequestInit): Promise<RunDetail> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? "The request failed.");
  }
  return runDetailSchema.parse(await response.json());
}

export function createRun(input: File | "happy") {
  const body = new FormData();
  if (input instanceof File) body.append("invoice", input);
  else body.append("fixtureId", input);
  return runRequest("/api/runs", { method: "POST", body });
}

export function processRun(runId: string) {
  return runRequest(`/api/runs/${runId}/process`, { method: "POST" });
}

export function confirmPo(runId: string, poNumber: string) {
  return runRequest(`/api/runs/${runId}/confirm-po`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ poNumber }),
  });
}

export function confirmBundle(runId: string, candidateId: string) {
  return runRequest(`/api/runs/${runId}/confirm-bundle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateId }),
  });
}

export function getRun(runId: string) {
  return runRequest(`/api/runs/${runId}`);
}
