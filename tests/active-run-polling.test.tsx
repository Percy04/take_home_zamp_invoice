// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouter } from "../client/src/router";
import * as store from "../client/src/lib/store";
import type { Run } from "../client/src/lib/types";
import * as api from "../client/src/lib/api";

vi.mock("../client/src/lib/api", () => ({
  getRun: vi.fn(),
  resetWorkspace: vi.fn(),
  documentUrl: vi.fn(() => "/document.pdf"),
}));

vi.mock("../client/src/components/DocumentPreview", () => ({
  DocumentPreview: () => <div>Source document</div>,
}));

const run = {
  runId: "11111111-1111-4111-8111-111111111111",
  filename: "invoice.pdf",
  state: "PROCESSING",
  execution: "PENDING",
  reasonCode: null,
  nextAction: null,
  ledgerId: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  stages: [],
  invoice: null,
  checks: [],
  activity: [],
} satisfies Run;

const duplicateSummary = {
  ...run,
  state: "NEEDS_REVIEW",
  execution: "BLOCKED",
  reasonCode: "DUPLICATE_INVOICE",
  invoice: {
    vendor: "Acme Industrial Supplies LLC",
    invoiceNumber: "ACME-2026-001",
    invoiceDate: null,
    poNumber: "PO-1001",
    currency: "USD",
    observedSubtotal: 990,
    observedTax: 0,
    observedTotal: 990,
    normalizedSubtotal: 990,
    normalizedTax: 0,
    normalizedTotal: 990,
    taxTreatment: "EXCLUSIVE" as const,
    lines: [],
  },
} satisfies Run;

describe("active run polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clearRuns();
    store.upsertRun(run);
    window.history.replaceState({}, "", `/runs/${run.runId}`);
    vi.mocked(api.getRun).mockResolvedValue(run);
  });

  afterEach(() => {
    store.clearRuns();
  });

  it("polls server stages while the run is active", async () => {
    render(<RouterProvider router={getRouter()} />);

    await waitFor(() => expect(api.getRun).toHaveBeenCalledTimes(2), {
      timeout: 1_000,
    });
  });

  it("does not render duplicate evidence until the detail fetch supplies the duplicate match", async () => {
    store.clearRuns();
    store.upsertRun(duplicateSummary);
    vi.mocked(api.getRun).mockResolvedValue(duplicateSummary);

    render(<RouterProvider router={getRouter()} />);

    await waitFor(() => expect(screen.getByLabelText("Decision evidence")).toBeVisible());
  });
});
