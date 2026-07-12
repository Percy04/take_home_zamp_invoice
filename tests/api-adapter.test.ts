import { describe, expect, it } from "vitest";
import type { RunDetail } from "../shared/contracts";
import { toUiRun } from "../frontend_v1/ap-resolve-console/src/lib/api-adapter";

describe("Lovable API adapter", () => {
  it("maps backend runs into the Lovable UI contract", () => {
    const run = toUiRun({
      runId: "11111111-1111-4111-8111-111111111111",
      filename: "duplicate.pdf",
      state: "NEEDS_REVIEW",
      decision: "NEEDS_REVIEW",
      execution: "BLOCKED",
      reasonCode: "DUPLICATE",
      nextAction: "Do not repost.",
      ledgerId: null,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:01:00.000Z",
      stages: [],
      evidence: [],
      invoice: null,
      invoicePreview: null,
      duplicateMatch: null,
      checks: [],
      allocations: [],
      candidatePo: null,
      poCandidates: [],
      bundleCandidates: [],
    } as RunDetail);

    expect(run).toMatchObject({
      scenario: "duplicate",
      state: "NEEDS_REVIEW",
      reasonCode: "DUPLICATE_INVOICE",
      execution: "BLOCKED",
    });
  });
});
