// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DecisionEvidence } from "../frontend_v1/ap-resolve-console/src/components/DecisionEvidence";
import type { Run } from "../frontend_v1/ap-resolve-console/src/lib/types";

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
    };

    render(<DecisionEvidence run={run} />);

    expect(screen.getByText("Compare with existing posting")).toBeVisible();
    expect(screen.getAllByText("✓ identical")).toHaveLength(4);
    expect(screen.getByText("LEDGER-bf1055b6")).toBeVisible();
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
});
