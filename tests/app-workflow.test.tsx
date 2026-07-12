// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../client/src/app";

vi.mock("../client/src/pdf-preview", () => ({
  default: () => <div>PDF preview</div>,
}));

const postedRunId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("invoice workflow UI", () => {
  it("explains why a posted invoice was approved", async () => {
    window.history.replaceState({}, "", `/runs/${postedRunId}`);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(runDetail({ state: "POSTED" }))),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Approved and posted" }),
    ).toBeVisible();
    expect(screen.getByText("How it was approved")).toBeVisible();
    expect(screen.getByText("Vendor matched")).toBeVisible();
    expect(screen.queryByText(/provider evidence/i)).not.toBeInTheDocument();
  });

  it("explains why a blocked invoice needs review", async () => {
    const runId = "22222222-2222-4222-8222-222222222222";
    window.history.replaceState({}, "", `/runs/${runId}`);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          runDetail({
            runId,
            state: "NEEDS_REVIEW",
            decision: "NEEDS_REVIEW",
            execution: "BLOCKED",
            reasonCode: "DUPLICATE",
            ledgerId: null,
            nextAction: "Verify that this is not a duplicate submission.",
          }),
        ),
      ),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Needs review" }),
    ).toBeVisible();
    expect(screen.getByText("Why this needs review")).toBeVisible();
    expect(screen.getAllByText("Duplicate invoice")).toHaveLength(2);
    expect(screen.getByText(/nothing was posted again/i)).toBeVisible();
  });

  it("shows a retry action when processing fails unexpectedly", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    window.history.replaceState({}, "", `/runs/${runId}`);
    const fetchMock = vi
      .fn()
      .mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/process") && init?.method === "POST")
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "UNEXPECTED_ERROR",
                  message: "Processing service unavailable.",
                },
              },
              500,
            ),
          );
        return Promise.resolve(
          jsonResponse(
            runDetail({
              runId,
              state: "PROCESSING",
              decision: null,
              execution: null,
              ledgerId: null,
              invoice: null,
              checks: [],
              allocations: [],
            }),
          ),
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Processing service unavailable.",
    );
    expect(
      screen.getByRole("button", { name: "Retry processing" }),
    ).toBeEnabled();
  });

  it("submits the stored PO confirmation", async () => {
    const runId = "44444444-4444-4444-8444-444444444444";
    window.history.replaceState({}, "", `/runs/${runId}`);
    const awaiting = runDetail({
      runId,
      state: "AWAITING_PO_CONFIRMATION",
      decision: "NEEDS_REVIEW",
      execution: "AWAITING_CONFIRMATION",
      reasonCode: "MISSING_PO",
      ledgerId: null,
      candidatePo: "PO-1002",
      poCandidates: [
        {
          poNumber: "PO-1002",
          allLinesResolvable: true,
          matchedLineCount: 1,
          remainingPoBasisValue: "500.00",
          subtotalDifference: "2.00",
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(awaiting)));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm PO" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/runs/${runId}/confirm-po`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("submits the stored bundle confirmation", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    window.history.replaceState({}, "", `/runs/${runId}`);
    const awaiting = runDetail({
      runId,
      state: "AWAITING_BUNDLE_CONFIRMATION",
      decision: "NEEDS_REVIEW",
      execution: "AWAITING_CONFIRMATION",
      reasonCode: "BUNDLE_MAPPING_REQUIRED",
      ledgerId: null,
      bundleCandidates: [
        {
          id: "BUNDLE-CANDIDATE-1",
          invoiceLineIndex: 0,
          bundleQuantity: "1",
          totalPoBasisAmount: "300.00",
          components: [
            {
              poLineId: "PO-1005-L1",
              sku: "WID-100",
              uom: "EA",
              quantity: "2",
              poBasisAmount: "200.00",
            },
          ],
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(awaiting)));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm bundle" }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/runs/${runId}/confirm-bundle`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});

describe("dashboard and workspace actions", () => {
  it("applies the selected dashboard status filter", async () => {
    window.history.replaceState({}, "", "/dashboard");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [],
        nextCursor: null,
        metrics: {
          totalRuns: 0,
          postedCount: 0,
          reviewCount: 0,
          autoClearRate: "0.0",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const filter = await screen.findByLabelText("Status");
    fireEvent.change(filter, { target: { value: "NEEDS_REVIEW" } });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("state=NEEDS_REVIEW"),
      ),
    );
  });

  it("resets the workspace after explicit confirmation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "reset" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Reset workspace" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/reset", { method: "POST" }),
    );
  });
});

function runDetail(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: postedRunId,
    filename: "happy.pdf",
    state: "POSTED",
    decision: "AUTO_CLEARED",
    execution: "POSTED",
    reasonCode: null,
    nextAction: null,
    ledgerId: "LEDGER-1",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:01.000Z",
    stages: [],
    evidence: [
      {
        id: "field.VendorName",
        content: "Acme Industrial Supplies LLC",
        confidence: 0.98,
        page: 1,
        label: "VendorName",
      },
    ],
    invoice: {
      vendor: "Acme Industrial Supplies LLC",
      invoiceNumber: "ACME-2026-001",
      invoiceDate: "2026-07-01",
      poNumber: "PO-1001",
      currency: "USD",
      observedSubtotal: "900.00",
      observedTax: "90.00",
      observedTotal: "990.00",
      taxTreatment: "EXCLUSIVE",
      taxRate: null,
      subtotal: "900.00",
      tax: "90.00",
      total: "990.00",
      lines: [
        {
          sku: "WID-100",
          description: "Industrial Widget",
          quantity: "1",
          uom: "EA",
          observedUnitPrice: "900.00",
          observedAmount: "900.00",
          unitPrice: "900.00",
          amount: "900.00",
        },
      ],
      fieldSources: { vendor: "field.VendorName" },
    },
    checks: [{ code: "VENDOR_MATCH", passed: true, detail: "Vendor matched." }],
    allocations: [
      {
        invoiceLineIndex: 0,
        poLineId: "PO-1001-L1",
        poNumber: "PO-1001",
        sku: "WID-100",
        quantity: "1",
        matchType: "DIRECT",
        bundleDefinitionId: null,
        poBasisAmount: "900.00",
        actualNetAmount: "900.00",
        remainingOrderedQuantity: "1",
        remainingReceivedQuantity: "1",
      },
    ],
    candidatePo: null,
    poCandidates: [],
    bundleCandidates: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
