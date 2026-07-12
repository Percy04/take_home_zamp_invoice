import {
  runDetailSchema,
  runListSchema,
  type RunDetail,
  type RunList,
} from "../../shared/contracts";

export const fixtureIds = [
  "happy",
  "duplicate",
  "missing_po",
  "receipt_capacity",
  "multiple_issues",
  "happy_layout_b",
  "happy_layout_c_scanned",
  "bundle_known",
  "bundle_unknown",
  "tax_inclusive",
] as const;

export type FixtureId = (typeof fixtureIds)[number];

async function runRequest(url: string, init?: RequestInit): Promise<RunDetail> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json()) as {
      error?: { message?: string; code?: string };
    };
    throw new ApiRequestError(
      body.error?.message ?? "The request failed.",
      body.error?.code,
    );
  }
  return runDetailSchema.parse(await response.json());
}

export function createRun(input: File | FixtureId) {
  const body = new FormData();
  if (input instanceof File) body.append("invoice", input);
  else body.append("fixtureId", input);
  return runRequest("/api/runs", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body,
  });
}

export async function listRuns(
  filters: {
    state?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<RunList> {
  const query = new URLSearchParams();
  if (filters.state) query.set("state", filters.state);
  if (filters.cursor) query.set("cursor", filters.cursor);
  if (filters.limit) query.set("limit", String(filters.limit));
  const response = await fetch(`/api/runs?${query}`);
  if (!response.ok) {
    const body = (await response.json()) as {
      error?: { message?: string; code?: string };
    };
    throw new ApiRequestError(
      body.error?.message ?? "The request failed.",
      body.error?.code,
    );
  }
  return runListSchema.parse(await response.json());
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

export function rejectPo(runId: string) {
  return runRequest(`/api/runs/${runId}/reject-po`, { method: "POST" });
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

export async function resetWorkspace() {
  const response = await fetch("/api/reset", { method: "POST" });
  if (!response.ok) {
    const body = (await response.json()) as {
      error?: { message?: string; code?: string };
    };
    throw new ApiRequestError(
      body.error?.message ?? "The workspace could not be reset.",
      body.error?.code,
    );
  }
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
