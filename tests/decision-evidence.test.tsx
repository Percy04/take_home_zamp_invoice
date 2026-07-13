// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionEvidence } from "../frontend_v1/ap-resolve-console/src/components/DecisionEvidence";
import * as api from "../frontend_v1/ap-resolve-console/src/lib/api";
import { reviewSummary } from "../frontend_v1/ap-resolve-console/src/lib/review-issues";
import type { Run } from "../frontend_v1/ap-resolve-console/src/lib/types";

vi.mock("../frontend_v1/ap-resolve-console/src/lib/api", () => ({
  confirmBundle: vi.fn(),
  rejectBundle: vi.fn(),
}));

const base = {
  runId: "11111111-1111-4111-8111-111111111111",
  filename: "invoice.pdf",
  execution: "BLOCKED",
  nextAction: null,
  ledgerId: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  stages: [],
  invoice: {
    vendor: "Acme Industrial Supplies LLC",
    invoiceNumber: "ACME-2026-001",
    invoiceDate: "2026-07-01",
    poNumber: "PO-1001",
    currency: "USD",
    observedSubtotal: 900,
    observedTax: 90,
    observedTotal: 990,
    normalizedSubtotal: 900,
    normalizedTax: 90,
    normalizedTotal: 990,
    taxTreatment: "EXCLUSIVE" as const,
    lines: [],
  },
  checks: [],
  activity: [],
} satisfies Omit<Run, "state" | "reasonCode">;

describe("DecisionEvidence", () => {
  afterEach(cleanup);
  beforeEach(() => vi.resetAllMocks());

  it("compares a duplicate against the existing posting", () => {
    const run: Run = {
      ...base,
      state: "NEEDS_REVIEW",
      reasonCode: "DUPLICATE_INVOICE",
      duplicateMatch: {
        ledgerId: "LEDGER-bf1055b6",
        originalInvoiceNumber: "ACME-2026-001",
        vendor: "Acme Industrial Supplies LLC",
        invoiceDate: "2026-07-01",
        poNumber: "PO-1001",
        total: 990,
        postedAt: "2026-07-12T12:00:00.000Z",
        originalLines: [],
      },
      checks: [
        {
          code: "DUPLICATE",
          name: "Duplicate control",
          category: "DUPLICATE",
          pass: false,
          explanation: "Matches an existing posting.",
        },
      ],
    };

    render(<DecisionEvidence run={run} />);

    expect(screen.getByText("Possible duplicate invoice")).toBeVisible();
    expect(
      screen.getByText(/matches a previously posted ledger entry/i),
    ).toBeVisible();
    expect(screen.getAllByText("✓ identical")).toHaveLength(4);
    expect(
      screen.getByText(/ACME-2026-001 · posted Jul 12, 2026/),
    ).toBeVisible();
    expect(screen.queryByText("Duplicate control")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "This invoice matches an existing ledger posting. It was not posted again.",
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps missing-date evidence to the issue and extracted fields", () => {
    const run: Run = {
      ...base,
      state: "NEEDS_REVIEW",
      reasonCode: "MISSING_FIELD",
      invoice: { ...base.invoice, invoiceDate: "" },
    };

    render(<DecisionEvidence run={run} />);

    expect(screen.getByText("Invoice date")).toBeVisible();
    expect(screen.getByText("Missing")).toBeVisible();
    expect(screen.getByText("Not found")).toBeVisible();
  });

  it("does not claim the invoice date is missing when the extracted date is present", () => {
    const run: Run = {
      ...base,
      state: "NEEDS_REVIEW",
      reasonCode: "MISSING_FIELD",
      invoice: { ...base.invoice, missingFields: ["lines.0.quantity"] },
    };

    render(<DecisionEvidence run={run} />);

    expect(screen.getByText("Line 1 quantity")).toBeVisible();
    expect(screen.queryByText("Invoice date")).not.toBeInTheDocument();
  });

  it("labels an unresolved full-document reread as an extraction issue", () => {
    const run: Run = {
      ...base,
      state: "NEEDS_REVIEW",
      reasonCode: "MISSING_FIELD",
      invoice: { ...base.invoice, missingFields: ["lines.0.quantity"] },
      aiRechecks: [
        {
          field: "lines.0.quantity",
          originalOcrValue: "",
          ocrConfidence: null,
          sourceId: "document",
          page: 1,
          aiValue: null,
          model: "test-model",
          attemptedAt: "2026-07-13T00:00:00.000Z",
          outcome: "needs_review",
        },
      ],
    };

    render(<DecisionEvidence run={run} />);

    expect(
      screen.getByRole("heading", { name: "Document extraction issue" }),
    ).toBeVisible();
    expect(screen.getByText("Line 1 quantity")).toBeVisible();
    expect(screen.getByText("Needs review")).toBeVisible();
    expect(
      screen.queryByText("Missing required field"),
    ).not.toBeInTheDocument();
  });

  it("keeps an ambiguous date as an extraction issue without adding a PO decision", () => {
    const run: Run = {
      ...base,
      state: "NEEDS_REVIEW",
      reasonCode: "AMBIGUOUS_DATE",
      invoice: { ...base.invoice, invoiceDate: "09.01.2025", poNumber: null },
    };

    render(<DecisionEvidence run={run} />);

    expect(
      screen.getByRole("heading", { name: "Document extraction issue" }),
    ).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Field" })).toBeVisible();
    expect(screen.getByText("Ambiguous")).toBeVisible();
    expect(screen.getByText("09.01.2025")).toBeVisible();
  });

  it("shows each independent failed control and a clear missing-date warning", () => {
    const run: Run = {
      ...base,
      state: "NEEDS_REVIEW",
      reasonCode: "MULTIPLE_ISSUES",
      issueCount: 2,
      checks: [
        {
          code: "PRICE",
          name: "Line 1 price above tolerance",
          category: "PRICE",
          pass: false,
          explanation: "Variance exceeds tolerance.",
        },
        {
          code: "DATE",
          name: "Invoice date could not be read",
          category: "IDENTITY",
          pass: false,
          explanation: "No date was found.",
        },
      ],
    };

    render(<DecisionEvidence run={run} />);

    expect(screen.getByText("Line 1 price above tolerance")).toBeVisible();
    expect(screen.getByText("Invoice date could not be read")).toBeVisible();
  });

  it("shows an unreconciled invoice as a business decision with actionable detail", () => {
    const run: Run = {
      ...base,
      state: "NEEDS_REVIEW",
      reasonCode: "TOTAL_MISMATCH",
      checks: [
        {
          code: "TOTAL_MISMATCH",
          name: "Total Mismatch",
          category: "ARITHMETIC",
          pass: false,
          explanation:
            "Review the current line items and totals for an omitted, duplicated, or inconsistent charge.",
        },
      ],
    };

    render(<DecisionEvidence run={run} />);

    expect(screen.getByText("Business decision required")).toBeVisible();
    expect(
      screen.getByRole("heading", {
        name: "Invoice lines do not match the total",
      }),
    ).toBeVisible();
    expect(
      screen.getAllByText("Invoice lines do not match the total"),
    ).toHaveLength(2);
    expect(
      screen.getByText(/omitted, duplicated, or inconsistent charge/i),
    ).toBeVisible();
  });

  it("uses plain quantity labels for a suggested purchase order", () => {
    const run: Run = {
      ...base,
      state: "AWAITING_PO_CONFIRMATION",
      execution: "AWAITING_CONFIRMATION",
      reasonCode: "MISSING_PO",
      invoice: { ...base.invoice, poNumber: null },
      checks: [
        {
          code: "MISSING_PO",
          name: "Missing PO",
          category: "ARITHMETIC",
          pass: false,
          explanation: "Invoice omitted its PO reference.",
        },
      ],
      poCandidates: [
        {
          poNumber: "PO-1002",
          vendor: "Acme Industrial Supplies LLC",
          confidence: "HIGH",
          aggregateDifference: 0,
          lines: [
            {
              invoiceSku: "SEN-300",
              invoiceDescription: "Safety Sensor",
              requestedQuantity: 2,
              uom: "EA",
              invoiceUnitPrice: 250,
              invoiceAmount: 500,
              poLineId: "PO-1002-L1",
              poSku: "SEN-300",
              poDescription: "Safety Sensor",
              poUnitPrice: 250,
              orderedAvailable: 2,
              receivedAvailable: 2,
              remainingPoValue: 500,
              priceVariancePct: 0,
              amountDifference: 0,
            },
          ],
        },
      ],
    };

    render(<DecisionEvidence run={run} />);

    expect(
      screen.getByRole("heading", { name: "Select the purchase order" }),
    ).toBeVisible();
    expect(
      screen.getByText(/does not identify a purchase order/i),
    ).toBeVisible();
    expect(screen.getAllByText("This invoice").at(-1)).toBeVisible();
    expect(screen.getByText("Available to invoice")).toBeVisible();
    expect(screen.queryByText("Received avail.")).not.toBeInTheDocument();
    expect(screen.queryByText("Ordered avail.")).not.toBeInTheDocument();
    expect(screen.getAllByText("Select the purchase order")).toHaveLength(1);
    expect(
      screen.queryByText(
        "Suggested PO line matches this invoice item and has enough quantity to invoice.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Confirming reruns price, capacity, and duplicate controls before anything posts.",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows a failed bundle confirmation instead of silently leaving the action pending", async () => {
    const run: Run = {
      ...base,
      state: "AWAITING_BUNDLE_CONFIRMATION",
      execution: "AWAITING_CONFIRMATION",
      reasonCode: "UNKNOWN_BUNDLE",
      bundleCandidates: [
        {
          candidateId: "BUNDLE-CANDIDATE-1",
          invoiceItemDescription: "Maintenance Pack",
          invoiceQuantity: 1,
          poNumber: "PO-1005",
          totalPoBasis: 300,
          components: [
            {
              poLineId: "PO-1005-L1",
              sku: "WID-100",
              description: "Industrial Widget",
              uom: "EA",
              quantity: 2,
              unitPrice: 100,
              poBasis: 200,
              orderedAvailable: 2,
              receivedAvailable: 2,
            },
          ],
        },
      ],
      checks: [
        {
          code: "LINE_MATCH",
          name: "Line match",
          category: "LINE_MATCH",
          pass: false,
          explanation: "The item requires a component mapping.",
        },
      ],
    };
    vi.mocked(api.confirmBundle).mockRejectedValueOnce(
      new Error("The requested run action is not valid."),
    );
    render(<DecisionEvidence run={run} />);

    expect(
      screen.getAllByText("Invoice item needs a component mapping"),
    ).toHaveLength(1);
    expect(
      screen.queryByText("Select the purchase order"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Line match")).not.toBeInTheDocument();
    expect(
      screen.getByText(/not a direct PO line; its quantity and value align/i),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm decomposition" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The requested run action is not valid.",
    );
  });

  it("shows low-confidence details alongside the extracted invoice", () => {
    const run: Run = {
      ...base,
      state: "NEEDS_REVIEW",
      reasonCode: "LOW_CONFIDENCE",
      invoice: {
        ...base.invoice,
        lines: [
          {
            sku: "WID-100",
            description: "Industrial Widget",
            quantity: 8,
            uom: "pcs",
            unitPrice: 100,
            amount: 800,
          },
        ],
      },
      evidence: [
        {
          id: "line.1.l0",
          content: "8 pcs",
          confidence: 0.62,
          page: 1,
          label: "OCR line",
        },
      ],
      checks: [
        {
          code: "LOW_CONFIDENCE",
          name: "Low confidence",
          category: "IDENTITY",
          pass: false,
          explanation: "Quantity could not be read reliably.",
          sourceRefs: [],
        },
      ],
    };

    render(<DecisionEvidence run={run} />);

    expect(screen.getByText("Quantity")).toBeVisible();
    expect(screen.getByText("Low confidence")).toBeVisible();
    expect(screen.getByText("8 pcs")).toBeVisible();
    expect(screen.getByText("62%")).toBeVisible();
    expect(screen.getByText("OCR line · page 1")).toBeVisible();
  });

  it("removes bundle actions after a decomposition is rejected", () => {
    const run: Run = {
      ...base,
      state: "NEEDS_REVIEW",
      reasonCode: "UNKNOWN_BUNDLE",
      nextAction:
        "The proposed decomposition was rejected. Route this invoice for manual AP review.",
      checks: [
        {
          code: "LINE_MATCH",
          name: "Line match",
          category: "LINE_MATCH",
          pass: false,
          explanation: "The item requires a component mapping.",
        },
      ],
      bundleCandidates: [
        {
          candidateId: "BUNDLE-CANDIDATE-1",
          invoiceItemDescription: "Maintenance Pack",
          invoiceQuantity: 1,
          poNumber: "PO-1005",
          totalPoBasis: 300,
          components: [],
        },
      ],
    };

    render(<DecisionEvidence run={run} />);

    expect(screen.getByText(/manual review required/i)).toBeVisible();
    expect(
      screen.getByText(/proposed decomposition was rejected/i),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Reject decomposition" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Line match")).not.toBeInTheDocument();
  });

  it.each([
    [
      "DUPLICATE_INVOICE",
      "This invoice matches a previously posted ledger entry and cannot be posted again.",
    ],
    [
      "PRICE_VARIANCE_EXCEEDED",
      "The invoice price differs from the purchase order beyond the allowed tolerance.",
    ],
    [
      "RECEIPT_CAPACITY_EXCEEDED",
      "The invoice quantity is greater than the goods received and available to invoice.",
    ],
    [
      "MULTIPLE_ISSUES",
      "More than one independent control requires a reviewer decision.",
    ],
  ] as const)(
    "explains why %s needs a business decision",
    (reasonCode, explanation) => {
      const summary = reviewSummary({
        ...base,
        state: "NEEDS_REVIEW",
        reasonCode,
      });

      expect(summary?.explanation).toBe(explanation);
    },
  );
});
