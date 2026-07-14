import { describe, expect, it } from "vitest";
import {
  buildInvoicePreview,
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
  it("recovers a compact line item from exact arithmetic", () => {
    const evidence = inclusiveEvidence().map((item) => ({ ...item }));
    evidence.find((item) => item.id === "sku")!.content =
      "Line 1: VAL-500 | Control Valve | 3 EA x $55.00 = $165.00";
    evidence.find((item) => item.id === "description")!.content =
      "Line 1: VAL-500 | Control Valve | 3 EA x $55.00 = $165.00";
    evidence.find((item) => item.id === "unitPrice")!.content = "$55.00";
    evidence.find((item) => item.id === "amount")!.content = "$165.00";
    evidence.find((item) => item.id === "total")!.content = "$165.00";
    const compact = {
      ...mapping,
      taxNote: null,
      lines: [
        {
          ...mapping.lines[0],
          quantity: "description",
          uom: "description",
          unitPrice: "description",
          amount: "description",
        },
      ],
    };

    expect(normalizeInvoice(evidence, compact).lines[0]).toMatchObject({
      sku: "VAL-500",
      description: "Control Valve",
      quantity: "3",
      uom: "EA",
      unitPrice: "55.00",
      amount: "165.00",
      derivations: [],
    });
  });

  it("derives a service line rate when hours and extension are printed", () => {
    const evidence = inclusiveEvidence().map((item) => ({ ...item }));
    evidence.find((item) => item.id === "sku")!.content = "";
    evidence.find((item) => item.id === "description")!.content =
      "Prepare Payout Request Log";
    evidence.find((item) => item.id === "quantity")!.content = "3.00";
    evidence.find((item) => item.id === "amount")!.content = "$375.00";
    evidence.find((item) => item.id === "total")!.content = "$375.00";
    const service = {
      ...mapping,
      taxNote: null,
      lines: [{ ...mapping.lines[0], unitPrice: null, uom: null }],
    };

    expect(normalizeInvoice(evidence, service).lines[0]).toMatchObject({
      description: "Prepare Payout Request Log",
      quantity: "3",
      uom: "",
      unitPrice: "125.00",
      amount: "375.00",
      derivations: [
        expect.objectContaining({
          field: "unitPrice",
          sourceIds: ["amount", "quantity"],
        }),
      ],
    });
  });

  it("classifies an unexplained gap between lines and total as a total mismatch", () => {
    const evidence = inclusiveEvidence();
    evidence.find((item) => item.id === "total")!.content = "$11,812.50";
    const noTaxEvidence = { ...mapping, taxNote: null };

    expect(() => normalizeInvoice(evidence, noTaxEvidence)).toThrowError(
      expect.objectContaining<Partial<NormalizationError>>({
        reasonCode: "TOTAL_MISMATCH",
      }),
    );
  });

  it("uses the unit embedded in a valid quantity when no UOM field is mapped", () => {
    const evidence = inclusiveEvidence();
    evidence.find((item) => item.id === "quantity")!.content = "2 pcs";
    const withoutUom = {
      ...mapping,
      lines: [{ ...mapping.lines[0], uom: null }],
    };

    expect(normalizeInvoice(evidence, withoutUom).lines[0]).toMatchObject({
      quantity: "2",
      uom: "EA",
    });
  });

  it("uses an unambiguous sibling date to resolve the invoice date order", () => {
    const evidence = inclusiveEvidence();
    evidence.find((item) => item.id === "date")!.content = "09.01.2025";
    evidence.push(source("dueDate", "09.14.2025", "DueDate"));

    expect(normalizeInvoice(evidence, mapping).invoiceDate).toBe("2025-09-01");
  });

  it("does not use unrelated dated fields to guess the invoice date order", () => {
    const evidence = inclusiveEvidence();
    evidence.find((item) => item.id === "date")!.content = "09.01.2025";
    evidence.push(source("serviceDate", "09.14.2025", "ServiceDate"));

    expect(() => normalizeInvoice(evidence, mapping)).toThrowError(
      expect.objectContaining<Partial<NormalizationError>>({
        reasonCode: "AMBIGUOUS_DATE",
      }),
    );
  });

  it("treats a printed tax rate without inclusive language as exclusive tax", () => {
    const evidence = inclusiveEvidence();
    evidence.find((item) => item.id === "date")!.content = "2025-09-01";
    evidence.find((item) => item.id === "unitPrice")!.content = "$1,000.00";
    evidence.find((item) => item.id === "amount")!.content = "$1,000.00";
    evidence.find((item) => item.id === "quantity")!.content = "1";
    evidence.find((item) => item.id === "total")!.content = "$1,050.00";
    evidence.push(source("subtotal", "$1,000.00", "SubTotal"));
    evidence.push(source("tax", "$50.00", "TotalTax"));
    evidence.push(source("lineRate", "5%", "TaxRate"));
    const exclusive: InvoiceMapping = {
      ...mapping,
      subtotal: "subtotal",
      tax: "tax",
      taxNote: null,
      lines: [
        {
          ...mapping.lines[0],
          taxRate: "lineRate",
          taxInclusion: null,
          taxAmount: null,
        },
      ],
    };

    expect(normalizeInvoice(evidence, exclusive)).toMatchObject({
      taxTreatment: "EXCLUSIVE",
      subtotal: "1000.00",
      tax: "50.00",
      total: "1050.00",
      lines: [{ taxRate: "0.05" }],
    });
  });

  it("preserves mapped evidence when normalization stops on a missing field", () => {
    const preview = buildInvoicePreview(
      inclusiveEvidence(),
      { ...mapping, invoiceDate: "missing-source" },
      "invoiceDate",
    );

    expect(preview).toMatchObject({
      vendor: "Acme Industrial Supplies LLC",
      invoiceNumber: "ACME-2026-005",
      invoiceDate: null,
      total: "$590.00",
      missingField: "invoiceDate",
      lines: [{ description: "Safety Sensor", quantity: "2" }],
    });
  });

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

  it("reports every low-confidence required field instead of stopping at the first", () => {
    const evidence = inclusiveEvidence();
    evidence.find((item) => item.id === "invoice")!.confidence = 0.6;
    evidence.find((item) => item.id === "quantity")!.confidence = 0.6;

    expect(() => normalizeInvoice(evidence, mapping)).toThrowError(
      expect.objectContaining({
        reasonCode: "MULTIPLE_ISSUES",
        fields: ["invoiceNumber", "lines.0.quantity"],
      }),
    );
  });

  it("normalizes common date and decimal formats without guessing ambiguous dates", () => {
    const evidence = inclusiveEvidence().map((item) => ({ ...item }));
    evidence.find((item) => item.id === "date")!.content = "06 Jul 2026";
    evidence.find((item) => item.id === "total")!.content = "$590,00";
    evidence.find((item) => item.id === "unitPrice")!.content = "$295,00";
    evidence.find((item) => item.id === "amount")!.content = "$590,00";

    expect(normalizeInvoice(evidence, mapping)).toMatchObject({
      invoiceDate: "2026-07-06",
      total: "590.00",
      lines: [{ observedUnitPrice: "295.00" }],
    });

    evidence.find((item) => item.id === "date")!.content = "06/07/2026";
    expect(() => normalizeInvoice(evidence, mapping)).toThrowError(
      expect.objectContaining<Partial<NormalizationError>>({
        reasonCode: "AMBIGUOUS_DATE",
      }),
    );
  });

  it("routes negative values and credit notes to review", () => {
    const negative = inclusiveEvidence();
    negative.find((item) => item.id === "total")!.content = "($590.00)";
    expect(() => normalizeInvoice(negative, mapping)).toThrowError(
      expect.objectContaining<Partial<NormalizationError>>({
        reasonCode: "UNSUPPORTED_STRUCTURE",
      }),
    );

    const credit = inclusiveEvidence();
    credit.push(source("creditNote", "Credit note", "OCR line"));
    expect(() => normalizeInvoice(credit, mapping)).toThrowError(
      expect.objectContaining<Partial<NormalizationError>>({
        reasonCode: "UNSUPPORTED_STRUCTURE",
      }),
    );
  });

  it("normalizes unambiguous line-specific mixed tax", () => {
    const mixedMapping: InvoiceMapping = {
      ...mapping,
      taxNote: null,
      lines: [
        {
          ...mapping.lines[0]!,
          taxInclusion: "line1TaxNote",
          taxRate: "line1TaxRate",
          taxAmount: null,
        },
        {
          sku: "sku2",
          description: "description2",
          quantity: "quantity2",
          uom: "uom2",
          unitPrice: "unitPrice2",
          amount: "amount2",
          taxInclusion: null,
          taxRate: null,
          taxAmount: "taxAmount2",
        },
      ],
    };
    const mixedEvidence = [
      source("vendor", "Acme Industrial Supplies LLC"),
      source("invoice", "ACME-2026-006"),
      source("date", "2026-07-07"),
      source("po", "PO-1006"),
      source("total", "$228.00", "InvoiceTotal"),
      source("sku", "INC-100"),
      source("description", "Tax inclusive item"),
      source("quantity", "1"),
      source("uom", "EA"),
      source("unitPrice", "$118.00", "UnitPrice"),
      source("amount", "$118.00", "Amount"),
      source("line1TaxNote", "Price includes tax", "TaxNote"),
      source("line1TaxRate", "18%", "TaxRate"),
      source("sku2", "EXC-100"),
      source("description2", "Tax exclusive item"),
      source("quantity2", "1"),
      source("uom2", "EA"),
      source("unitPrice2", "$100.00", "UnitPrice"),
      source("amount2", "$100.00", "Amount"),
      source("taxAmount2", "$10.00", "TaxAmount"),
    ];

    expect(normalizeInvoice(mixedEvidence, mixedMapping)).toMatchObject({
      taxTreatment: "MIXED",
      subtotal: "200.00",
      tax: "28.00",
      total: "228.00",
      lines: [
        { amount: "100.00", taxAmount: "18.00", taxTreatment: "INCLUSIVE" },
        { amount: "100.00", taxAmount: "10.00", taxTreatment: "EXCLUSIVE" },
      ],
    });
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
