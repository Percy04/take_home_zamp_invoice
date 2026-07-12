import { describe, expect, it } from "vitest";
import {
  NormalizationError,
  normalizeInvoice,
} from "../server/src/controls.js";
import {
  ProviderError,
  withOneMappingRetry,
  type InvoiceMapping,
} from "../server/src/providers.js";
import type { SourceRef } from "../shared/contracts.js";

const mapping: InvoiceMapping = {
  vendor: "vendor",
  invoiceNumber: "invoice",
  invoiceDate: "date",
  poNumber: "po",
  currency: null,
  subtotal: null,
  tax: null,
  total: "total",
  taxNote: "taxNote",
  lines: [
    {
      sku: "sku",
      description: "description",
      quantity: "quantity",
      uom: "uom",
      unitPrice: "unitPrice",
      amount: "amount",
    },
  ],
};

function source(
  id: string,
  content: string,
  label = id,
  confidence: number | null = 1,
): SourceRef {
  return { id, content, label, confidence, page: 1 };
}

function inclusiveEvidence(): SourceRef[] {
  return [
    source("vendor", "Acme Industrial Supplies LLC"),
    source("invoice", "ACME-2026-005"),
    source("date", "July 6, 2026"),
    source("po", "PO-1002"),
    source("total", "$590.00", "InvoiceTotal"),
    source("taxNote", "All line prices include 18% tax.", "TaxNote"),
    source("sku", "SEN-300"),
    source("description", "Safety Sensor"),
    source("quantity", "2"),
    source("uom", "pcs"),
    source("unitPrice", "$295.00", "UnitPrice"),
    source("amount", "$590.00", "Amount"),
  ];
}

describe("deterministic normalization", () => {
  it("preserves observed inclusive values and derives exact net values", () => {
    const invoice = normalizeInvoice(inclusiveEvidence(), mapping);

    expect(invoice).toMatchObject({
      invoiceDate: "2026-07-06",
      currency: "USD",
      observedTotal: "590.00",
      taxTreatment: "INCLUSIVE",
      taxRate: "0.18",
      subtotal: "500.00",
      tax: "90.00",
      lines: [
        {
          uom: "EA",
          observedUnitPrice: "295.00",
          observedAmount: "590.00",
          unitPrice: "250.00",
          amount: "500.00",
          sourceIds: {
            observedAmount: "amount",
            observedUnitPrice: "unitPrice",
          },
          derivations: [
            {
              field: "amount",
              sourceIds: ["amount", "taxNote"],
            },
          ],
        },
      ],
      fieldSources: {
        vendor: "vendor",
        observedTotal: "total",
        taxNote: "taxNote",
      },
      derivations: [
        { field: "subtotal" },
        { field: "tax", sourceIds: ["total", "taxNote"] },
      ],
    });
  });

  it("passes confidence 0.75 and blocks lower selected evidence", () => {
    const atThreshold = inclusiveEvidence();
    atThreshold[0]!.confidence = 0.75;
    expect(normalizeInvoice(atThreshold, mapping).vendor).toContain("Acme");

    const below = inclusiveEvidence();
    below[0]!.confidence = 0.749;
    expect(() => normalizeInvoice(below, mapping)).toThrowError(
      expect.objectContaining<Partial<NormalizationError>>({
        reasonCode: "LOW_CONFIDENCE",
      }),
    );
  });

  it("blocks unsupported non-zero charges before accounting controls", () => {
    const evidence = [
      ...inclusiveEvidence(),
      source("freight", "$1.00", "Freight"),
    ];
    expect(() => normalizeInvoice(evidence, mapping)).toThrowError(
      expect.objectContaining<Partial<NormalizationError>>({
        reasonCode: "UNSUPPORTED_STRUCTURE",
      }),
    );
  });
});

describe("mapping retry", () => {
  it("retries a transient or malformed mapping once", async () => {
    let calls = 0;
    await expect(
      withOneMappingRetry(async () => {
        calls += 1;
        if (calls === 1)
          throw new ProviderError("OPENAI_MAPPING", "malformed", {
            malformed: true,
          });
        return "mapped";
      }),
    ).resolves.toBe("mapped");
    expect(calls).toBe(2);
  });

  it("does not retry permanent authentication failures", async () => {
    let calls = 0;
    await expect(
      withOneMappingRetry(async () => {
        calls += 1;
        throw new ProviderError("GEMINI_MAPPING", "unauthorized", {
          status: 401,
        });
      }),
    ).rejects.toThrow("unauthorized");
    expect(calls).toBe(1);
  });
});
