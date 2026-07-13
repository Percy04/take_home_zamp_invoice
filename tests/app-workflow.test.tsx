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
import { runDetailSchema, type RunDetail } from "../shared/contracts";

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
            duplicateMatch: {
              ledgerId: "LEDGER-SEED-001",
              invoiceNumber: "ACME-2026-000",
              invoiceDate: "2026-06-01",
              poNumber: "PO-0999",
              total: "110.00",
              postedAt: "2026-06-01T10:00:00.000Z",
              allocations: [
                {
                  poLineId: "PO-0999-L1",
                  sku: "FIL-900",
                  description: "Replacement Filter",
                  uom: "EA",
                  quantity: "1",
                  unitPrice: "100.00",
                  poBasisAmount: "100.00",
                },
              ],
            },
          }),
        ),
      ),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Needs review" }),
    ).toBeVisible();
    expect(screen.getByText("Business decision required")).toBeVisible();
    expect(screen.getAllByText("Possible duplicate invoice")).toHaveLength(2);
    expect(screen.getByText(/nothing was posted again/i)).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Existing ledger invoice" }),
    ).toBeVisible();
    expect(screen.getByText("LEDGER-SEED-001")).toBeVisible();
    expect(screen.getByText("Replacement Filter")).toBeVisible();
  });

  it("shows partial invoice evidence and identifies the missing field", async () => {
    const runId = "22222222-2222-4222-8222-222222222224";
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
            reasonCode: "MISSING_REQUIRED_FIELD",
            ledgerId: null,
            invoice: null,
            invoicePreview: {
              vendor: "Acme Industrial Supplies LLC",
              invoiceNumber: "ACME-2026-001",
              invoiceDate: null,
              poNumber: "PO-1001",
              currency: "USD",
              subtotal: "$900.00",
              tax: "$90.00",
              total: "$990.00",
              missingField: "invoiceDate",
              lines: [
                {
                  sku: "WID-100",
                  description: "Industrial Widget",
                  quantity: "8",
                  uom: "EA",
                  unitPrice: "$100.00",
                  amount: "$800.00",
                },
              ],
            },
            checks: [
              {
                code: "MISSING_REQUIRED_FIELD",
                passed: false,
                detail:
                  "Invoice date is missing or could not be read reliably.",
                expected: "A readable invoice date",
                actual: "Not found",
              },
            ],
          }),
        ),
      ),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "What the system could read",
      }),
    ).toBeVisible();
    expect(screen.getByText("Invoice date missing")).toBeVisible();
    expect(screen.getByText("Industrial Widget")).toBeVisible();
    expect(screen.getByText("$990.00")).toBeVisible();
  });

  it("summarizes independent failures together", async () => {
    const runId = "22222222-2222-4222-8222-222222222223";
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
            reasonCode: "MULTIPLE_ISSUES",
            ledgerId: null,
            checks: [
              {
                code: "PRICE_MATCH",
                passed: false,
                detail: "Price differs.",
                calculation: {
                  kind: "PRICE_VARIANCE",
                  sku: "WID-100",
                  uom: "EA",
                  quantity: "3",
                  invoiceUnitPrice: "55.00",
                  poUnitPrice: "50.00",
                  varianceAmount: "15.00",
                  variancePercent: "10.00",
                  tolerancePercent: "1.00",
                },
              },
              {
                code: "RECEIPT_CAPACITY",
                passed: false,
                detail: "Receipt quantity is insufficient.",
                calculation: {
                  kind: "RECEIPT_CAPACITY",
                  sku: "VAL-500",
                  uom: "EA",
                  requestedQuantity: "3",
                  receivedAvailability: "2",
                  orderedAvailability: "6",
                  shortfall: "1",
                },
              },
            ],
          }),
        ),
      ),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "2 issues need attention" }),
    ).toBeVisible();
    expect(screen.getAllByText("Price differs from PO").length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getAllByText("Quantity exceeds received goods").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /Requested 3 EA; received availability 2 EA; shortfall 1 EA/i,
      ),
    ).toBeVisible();
  });

  it("shows OCR and AI evidence only when document extraction still needs review", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
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
            reasonCode: "LOW_CONFIDENCE",
            ledgerId: null,
            nextAction: "Review the source document.",
            aiRechecks: [
              {
                field: "lines.0.quantity",
                originalOcrValue: "8",
                ocrConfidence: 0.62,
                sourceId: "item.0.Quantity",
                page: 1,
                aiValue: null,
                model: "gpt-5-mini",
                attemptedAt: "2026-07-13T10:00:00.000Z",
                outcome: "needs_review",
              },
            ],
          }),
        ),
      ),
    );

    render(<App />);

    expect(
      await screen.findByLabelText("Document extraction issue"),
    ).toBeVisible();
    expect(screen.getAllByText("OCR reading")[0]).toBeVisible();
    expect(screen.getAllByText("OCR confidence")[0]).toBeVisible();
    expect(screen.getAllByText("AI re-read")[0]).toBeVisible();
    expect(screen.getAllByText("Source/page")[0]).toBeVisible();
    expect(screen.getAllByText("62%")[0]).toBeVisible();
    expect(screen.getAllByText("No usable value")[0]).toBeVisible();
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
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The server may still be processing this invoice.",
    );
    expect(
      screen.getByRole("button", { name: "Refresh status" }),
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
          lines: [
            {
              invoiceLineIndex: 0,
              invoiceSku: "SEN-300",
              invoiceDescription: "Safety Sensor",
              requestedQuantity: "2",
              uom: "EA",
              poLineId: "PO-1002-L1",
              poSku: "SEN-300",
              poDescription: "Safety Sensor",
              poUnitPrice: "250.00",
              availableOrderedQuantity: "2",
              availableReceivedQuantity: "2",
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
    expect(
      await screen.findByRole("button", { name: "Not this PO" }),
    ).toBeEnabled();
    expect(screen.getByText(/2 EA requested/)).toBeVisible();
    expect(screen.getByText(/2 received available/)).toBeVisible();
    const action = screen.getByLabelText("PO confirmation");
    const evidence = screen.getByRole("heading", {
      name: "Select the purchase order",
    });
    const document = screen.getByRole("heading", { name: "Original PDF" });
    expect(
      action.compareDocumentPosition(evidence) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      evidence.compareDocumentPosition(document) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

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
      invoice: {
        ...runDetail({}).invoice!,
        poNumber: "PO-1005",
        lines: [
          {
            ...runDetail({}).invoice!.lines[0]!,
            sku: "",
            description: "Maintenance Pack",
            quantity: "1",
            uom: "KIT",
          },
        ],
      },
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
              description: "Industrial Widget",
              unitPrice: "100.00",
              availableOrderedQuantity: "2",
              availableReceivedQuantity: "2",
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
    expect(await screen.findByText("PO PO-1005")).toBeVisible();
    expect(screen.getByText("Industrial Widget")).toBeVisible();
    expect(screen.getByText(/2 received available/)).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

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

function runDetail(overrides: Record<string, unknown> = {}): RunDetail {
  return runDetailSchema.parse({
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
    invoicePreview: null,
    duplicateMatch: null,
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
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
