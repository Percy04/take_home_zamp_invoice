import { describe, expect, it } from "vitest";
import type { RunDetail, RunSummary } from "../shared/contracts";
import { toUiRun, toUiSummary } from "../client/src/lib/api-adapter";

describe("Lovable API adapter", () => {
  it("keeps supplier context in activity summaries", () => {
    const run = toUiSummary({
      runId: "11111111-1111-4111-8111-111111111111",
      filename: "bundle_unknown.pdf",
      vendor: "Acme Industrial Supplies LLC",
      invoiceNumber: "ACME-2026-001",
      poNumber: "PO-1001",
      total: "990.00",
      currency: "USD",
      state: "AWAITING_BUNDLE_CONFIRMATION",
      decision: "NEEDS_REVIEW",
      execution: "AWAITING_CONFIRMATION",
      reasonCode: "BUNDLE_MAPPING_REQUIRED",
      ledgerId: null,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:01:00.000Z",
    } as RunSummary);

    expect(run.invoice).toMatchObject({
      vendor: "Acme Industrial Supplies LLC",
      invoiceNumber: "ACME-2026-001",
      poNumber: "PO-1001",
      normalizedTotal: 990,
    });
  });

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
      state: "NEEDS_REVIEW",
      reasonCode: "DUPLICATE_INVOICE",
      execution: "BLOCKED",
    });
  });

  it("preserves typed receipt calculations instead of parsing display copy", () => {
    const run = toUiRun({
      runId: "11111111-1111-4111-8111-111111111111",
      filename: "multiple_issues.pdf",
      state: "NEEDS_REVIEW",
      decision: "NEEDS_REVIEW",
      execution: "BLOCKED",
      reasonCode: "MULTIPLE_ISSUES",
      nextAction: "Resolve every failed control.",
      ledgerId: null,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:01:00.000Z",
      stages: [],
      evidence: [],
      invoice: null,
      invoicePreview: null,
      duplicateMatch: null,
      checks: [
        {
          code: "RECEIPT_CAPACITY",
          passed: false,
          detail: "Exact display copy is not used as the calculation source.",
          category: "CAPACITY",
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
      allocations: [],
      candidatePo: null,
      poCandidates: [],
      bundleCandidates: [],
    } as RunDetail);

    expect(run.capacityIssues).toEqual([
      expect.objectContaining({
        sku: "VAL-500",
        uom: "EA",
        requested: 3,
        receivedAvailable: 2,
        orderedAvailable: 6,
        shortfall: 1,
      }),
    ]);
  });

  it("keeps extracted USD preview amounts visible when date normalization is blocked", () => {
    const run = toUiRun({
      runId: "5510339d-5647-455b-91f3-272361da4a54",
      filename: "02-Invoice-2.pdf",
      state: "NEEDS_REVIEW",
      decision: "NEEDS_REVIEW",
      execution: "BLOCKED",
      reasonCode: "AMBIGUOUS_DATE",
      nextAction: "Confirm whether 09.01.2025 is day-month or month-day.",
      ledgerId: null,
      createdAt: "2026-07-13T09:53:57.781Z",
      updatedAt: "2026-07-13T09:54:09.663Z",
      stages: [],
      evidence: [],
      invoice: null,
      invoicePreview: {
        vendor: "Keystone Contractors",
        invoiceNumber: "1001",
        invoiceDate: "09.01.2025",
        poNumber: null,
        currency: "USD",
        subtotal: "$1 000.00",
        tax: "$50.00",
        total: "$1 050.00",
        missingField: "invoiceDate",
        lines: [
          {
            sku: null,
            description: "Portfolio review",
            quantity: "1",
            uom: null,
            unitPrice: "$1 000.00",
            amount: "$1 000.00",
          },
        ],
      },
      duplicateMatch: null,
      checks: [],
      allocations: [],
      candidatePo: null,
      poCandidates: [],
      bundleCandidates: [],
    } as RunDetail);

    expect(run.reasonCode).toBe("AMBIGUOUS_DATE");
    expect(run.invoice).toMatchObject({
      observedSubtotal: 1000,
      observedTax: 50,
      observedTotal: 1050,
      normalizedTotal: 1050,
      lines: [{ unitPrice: 1000, amount: 1000 }],
    });
  });

  it("keeps low-confidence scanned values visible and parses quantities with their unit", () => {
    const run = toUiRun({
      runId: "5510339d-5647-455b-91f3-272361da4a54",
      filename: "happy_layout_c_scanned.pdf",
      state: "NEEDS_REVIEW",
      decision: "NEEDS_REVIEW",
      execution: "BLOCKED",
      reasonCode: "LOW_CONFIDENCE",
      nextAction: "Verify the highlighted values in the source document.",
      ledgerId: null,
      createdAt: "2026-07-13T09:53:57.781Z",
      updatedAt: "2026-07-13T09:54:09.663Z",
      stages: [],
      evidence: [
        {
          id: "line.1.l0",
          content: "8 pcs",
          confidence: 0.62,
          page: 1,
          label: "OCR line",
        },
      ],
      invoice: null,
      invoicePreview: {
        vendor: "Acme Industrial Supplies LLC",
        invoiceNumber: "ACME-2026-001",
        invoiceDate: "2026-07-01",
        poNumber: "PO-1001",
        currency: "USD",
        subtotal: "$900.00",
        tax: "$90.00",
        total: "$990.00",
        missingField: "lines.0.quantity",
        lines: [
          {
            sku: "WID-100",
            description: "Industrial Widget",
            quantity: "8 pcs",
            uom: null,
            unitPrice: "$100.00",
            amount: "$800.00",
          },
        ],
      },
      duplicateMatch: null,
      checks: [
        {
          code: "LOW_CONFIDENCE",
          passed: false,
          detail: "Product code and quantity could not be read reliably.",
          category: "IDENTITY",
          sourceIds: ["line.1.l0"],
        },
      ],
      allocations: [],
      candidatePo: null,
      poCandidates: [],
      bundleCandidates: [],
    } as RunDetail);

    expect(run.reasonCode).toBe("LOW_CONFIDENCE");
    expect(run.invoice).toMatchObject({
      invoiceDate: "2026-07-01",
      poNumber: "PO-1001",
      lines: [{ quantity: 8, uom: "pcs" }],
    });
    expect(run.invoice?.missingFields).toBeUndefined();
    expect(run.evidence).toEqual([
      expect.objectContaining({ id: "line.1.l0", content: "8 pcs", confidence: 0.62 }),
    ]);
  });
});
