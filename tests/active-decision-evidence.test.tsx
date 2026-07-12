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
  activity: [],
} satisfies Run;

describe("active decision evidence", () => {
  it("renders every independent failure and the receipt calculation", () => {
    render(<DecisionEvidence run={run} />);

    expect(screen.getByText("Price variance")).toBeVisible();
    expect(screen.getByText(/\$15\.00 total variance/)).toBeVisible();
    expect(screen.getByText("Receipt capacity")).toBeVisible();
    expect(screen.getByText("Requested")).toBeVisible();
    expect(screen.getByText("3 EA")).toBeVisible();
    expect(screen.getByText("1 EA")).toBeVisible();
  });
});
