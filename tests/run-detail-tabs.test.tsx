// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunDetailTabs } from "../client/src/components/RunDetailTabs";
import type { Run } from "../client/src/lib/types";

const run = {
  runId: "11111111-1111-4111-8111-111111111111",
  filename: "receipt_capacity.pdf",
  state: "NEEDS_REVIEW",
  execution: "BLOCKED",
  reasonCode: "RECEIPT_CAPACITY_EXCEEDED",
  nextAction: "Record the receipt.",
  ledgerId: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  stages: [],
  invoice: {
    vendor: "Delta Components Ltd",
    invoiceNumber: "DELTA-2026-010",
    invoiceDate: "2026-07-03",
    poNumber: "PO-2001",
    currency: "USD",
    observedSubtotal: 150,
    observedTax: 15,
    observedTotal: 165,
    normalizedSubtotal: 150,
    normalizedTax: 15,
    normalizedTotal: 165,
    taxTreatment: "EXCLUSIVE" as const,
    lines: [],
  },
  poCandidates: [
    {
      poNumber: "PO-2001",
      vendor: "Delta Components Ltd",
      confidence: "HIGH" as const,
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
  checks: [],
  activity: [],
} satisfies Run;

describe("RunDetailTabs", () => {
  it("uses a plain-language PO reconciliation for receipt capacity", () => {
    render(<RunDetailTabs run={run} />);
    fireEvent.click(screen.getByRole("tab", { name: "Purchase order" }));

    expect(screen.getByText("PO ordered")).toBeVisible();
    expect(screen.getByText("Goods received")).toBeVisible();
    expect(screen.getByText("Already invoiced")).toBeVisible();
    expect(screen.getByText("Available to invoice")).toBeVisible();
    expect(screen.getByText("This invoice")).toBeVisible();
    expect(screen.getByText("Invoice PO value")).toBeVisible();
    expect(screen.getByText("10")).toBeVisible();
    expect(screen.getByText("6")).toBeVisible();
    expect(screen.getByText("4")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.getByText("$150.00")).toBeVisible();
    expect(screen.queryByText("Short by")).not.toBeInTheDocument();
  });
});
