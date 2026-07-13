// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DecisionEvidence } from "../frontend_v1/ap-resolve-console/src/components/DecisionEvidence";
import type { Run } from "../frontend_v1/ap-resolve-console/src/lib/types";

const run = {
  runId: "11111111-1111-4111-8111-111111111111",
  filename: "multiple_issues.pdf",
  state: "NEEDS_REVIEW",
  execution: "BLOCKED",
  reasonCode: "MULTIPLE_ISSUES",
  nextAction: "Resolve every failed control.",
  ledgerId: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  stages: [],
  invoice: null,
  checks: [
    {
      code: "PRICE_MATCH",
      name: "Price variance",
      category: "LINE_MATCH",
      pass: false,
      explanation: "Invoice price exceeds the PO price.",
      calculation: {
        kind: "PRICE_VARIANCE",
        sku: "VAL-500",
        uom: "EA",
        quantity: 3,
        invoiceUnitPrice: 55,
        poUnitPrice: 50,
        varianceAmount: 15,
        variancePercent: "10.00",
        tolerancePercent: "1.00",
      },
    },
    {
      code: "RECEIPT_CAPACITY",
      name: "Receipt capacity",
      category: "CAPACITY",
      pass: false,
      explanation:
        "Requested 3 EA; received availability 2 EA; shortfall 1 EA.",
    },
    {
      code: "PRICE_MATCH",
      name: "Price variance",
      category: "MATCHING",
      pass: false,
      explanation: "Aggregate direct-line price variance is at most $5.00.",
    },
  ],
  capacityIssues: [
    {
      poNumber: "PO-2001",
      sku: "VAL-500",
      description: "Control Valve",
      uom: "EA",
      requested: 3,
      receivedAvailable: 2,
      orderedAvailable: 6,
      shortfall: 1,
    },
  ],
  poCandidates: [
    {
      poNumber: "PO-2001",
      vendor: "Delta Components Ltd",
      confidence: "HIGH",
      aggregateDifference: 0,
      lines: [
        {
          invoiceSku: "VAL-500",
          invoiceDescription: "Control Valve",
          requestedQuantity: 3,
          uom: "EA",
          invoiceUnitPrice: 50,
          invoiceAmount: 150,
          poLineId: "PO-2001-L1",
          poSku: "VAL-500",
          poDescription: "Control Valve",
          poUnitPrice: 50,
          orderedAvailable: 6,
          receivedAvailable: 2,
          orderedQuantity: 10,
          receivedQuantity: 6,
          previouslyInvoicedQuantity: 4,
          remainingPoValue: 300,
          priceVariancePct: 0,
          amountDifference: 0,
        },
      ],
    },
  ],
  activity: [],
} satisfies Run;

describe("active decision evidence", () => {
  it("renders every independent failure and the receipt calculation", () => {
    render(<DecisionEvidence run={run} />);

    expect(screen.getAllByText("Price differs from PO")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "2 issues require review" }),
    ).toBeVisible();
    expect(screen.getByText("Quantity exceeds received goods")).toBeVisible();
    expect(screen.getByText(/\$15\.00 total variance/)).toBeVisible();
    const issueCards = document.querySelectorAll("[data-review-issue]");
    expect(issueCards).toHaveLength(2);
    expect(new Set([...issueCards].map((card) => card.className))).toHaveLength(
      1,
    );
    expect(issueCards[0]?.parentElement).toHaveClass("space-y-2");
    expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
    expect(screen.queryByText("Capacity check")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Why this invoice is blocked"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Receipt capacity")).not.toBeInTheDocument();
    expect(screen.queryByText("Still needed")).not.toBeInTheDocument();
    expect(screen.queryByText("PO ordered")).not.toBeInTheDocument();
    expect(screen.queryByText("Previously invoiced")).not.toBeInTheDocument();
  });
});
