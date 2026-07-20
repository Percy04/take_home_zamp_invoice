import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { recheckMissingFieldsWithFullDocument, recheckLowConfidenceFields } from "../server/src/ai-rechecks.js";
import {
  invoiceMappingSchemaForEvidence,
  preferReliableEvidence,
  restoreRecheckedMapping,
  validateMapping,
} from "../server/src/invoice-mapping.js";
import { ProviderError } from "../server/src/provider-errors.js";
import { buildSourceCatalogue } from "../server/src/providers.js";
import type { SourceRef } from "../shared/contracts.js";

describe("Azure evidence catalogue", () => {
  it("keeps recorded extraction out of shipped server code", async () => {
    const sourceDirectory = path.resolve("server/src");
    const files = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".ts"));
    const source = (await Promise.all(files.map((file) => readFile(path.join(sourceDirectory, file), "utf8")))).join("\n");

    expect(source).not.toMatch(/provider_mode|recorded|RECORDED_PROVIDER/i);
  });

  it("preserves fields, tax details, tables, OCR confidence, and key-value evidence", () => {
    const evidence = buildSourceCatalogue({
      status: "succeeded",
      analyzeResult: {
        documents: [
          {
            fields: {
              VendorName: {
                content: "Acme Industrial Supplies LLC",
                confidence: 0.97,
                boundingRegions: [{ pageNumber: 1 }],
              },
              TaxDetails: {
                valueArray: [
                  {
                    valueObject: {
                      Rate: {
                        content: "18%",
                        confidence: 0.93,
                        boundingRegions: [{ pageNumber: 1 }],
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
        pages: [
          {
            pageNumber: 1,
            lines: [{ content: "Total $590.00", spans: [{ offset: 10, length: 13 }] }],
            words: [
              { confidence: 0.96, span: { offset: 10, length: 5 } },
              { confidence: 0.88, span: { offset: 16, length: 7 } },
            ],
          },
        ],
        tables: [
          {
            cells: [
              {
                content: "SEN-300",
                rowIndex: 1,
                columnIndex: 0,
                boundingRegions: [{ pageNumber: 1 }],
              },
            ],
          },
        ],
        keyValuePairs: [
          {
            confidence: 0.91,
            key: {
              content: "Purchase Order",
              boundingRegions: [{ pageNumber: 1 }],
            },
            value: {
              content: "PO-1002",
              boundingRegions: [{ pageNumber: 1 }],
            },
          },
        ],
      },
    });

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "field.VendorName",
          sourceKind: "FIELD",
          confidence: 0.97,
        }),
        expect.objectContaining({
          id: "tax.0.Rate",
          sourceKind: "TAX",
        }),
        expect.objectContaining({
          id: "table.0.r1.c0",
          sourceKind: "TABLE",
          tableIndex: 0,
          row: 1,
          column: 0,
        }),
        expect.objectContaining({
          id: "line.1.l0",
          sourceKind: "OCR_LINE",
          confidence: 0.88,
          lineIndex: 0,
        }),
        expect.objectContaining({
          id: "key_value.0.value",
          content: "PO-1002",
          sourceKind: "KEY_VALUE",
        }),
      ]),
    );
  });
});

describe("mapping evidence validation", () => {
  it("permits partial mappings and any evidenced unit of measure", () => {
    const evidence = [
      "field.VendorName",
      "field.InvoiceId",
      "field.InvoiceDate",
      "field.InvoiceTotal",
      "item.0.Description",
      "item.0.Quantity",
      "item.0.Unit",
      "item.0.UnitPrice",
      "item.0.Amount",
    ].map((id) => ({
      id,
      content: id,
      confidence: 1,
      page: 1,
      label: id,
    }));

    expect(
      invoiceMappingSchemaForEvidence(evidence).safeParse({
        vendor: null,
        invoiceNumber: null,
        invoiceDate: null,
        poNumber: null,
        currency: null,
        subtotal: null,
        tax: null,
        total: null,
        taxNote: null,
        lines: [
          {
            sku: null,
            description: "item.0.Description",
            quantity: "item.0.Quantity",
            uom: "item.0.Unit",
            unitPrice: "item.0.UnitPrice",
            amount: "item.0.Amount",
            taxInclusion: null,
            taxRate: null,
            taxAmount: null,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("only permits mapper references present in the evidence catalogue", () => {
    const ids = [
      "field.VendorName",
      "field.InvoiceId",
      "field.InvoiceDate",
      "field.InvoiceTotal",
      "item.0.Description",
      "item.0.Quantity",
      "item.0.Unit",
      "item.0.UnitPrice",
      "item.0.Amount",
    ];
    const schema = invoiceMappingSchemaForEvidence(
      ids.map((id) => ({
        id,
        content: id,
        confidence: 1,
        page: 1,
        label: id,
      })),
    );

    const mapping = {
      vendor: "field.VendorName",
      invoiceNumber: "field.InvoiceId",
      invoiceDate: "field.InvoiceDate",
      poNumber: null,
      currency: null,
      subtotal: null,
      tax: null,
      total: "field.InvoiceTotal",
      taxNote: null,
      lines: [
        {
          sku: null,
          description: "item.0.Description",
          quantity: "item.0.Quantity",
          uom: "EA",
          unitPrice: "item.0.UnitPrice",
          amount: "item.0.Amount",
          taxInclusion: null,
          taxRate: null,
          taxAmount: null,
        },
      ],
    };

    expect(schema.safeParse(mapping).success).toBe(false);
    expect(
      schema.safeParse({
        ...mapping,
        lines: [{ ...mapping.lines[0], uom: null }],
      }).success,
    ).toBe(true);
  });

  it("reports the exact unknown source IDs", () => {
    const knownIds = [
      "field.InvoiceId",
      "field.InvoiceDate",
      "field.InvoiceTotal",
      "item.0.Description",
      "item.0.Quantity",
      "item.0.Unit",
      "item.0.UnitPrice",
      "item.0.Amount",
    ];
    expect(() =>
      validateMapping(
        {
          vendor: "field.UnknownVendor",
          invoiceNumber: "field.InvoiceId",
          invoiceDate: "field.InvoiceDate",
          poNumber: null,
          currency: null,
          subtotal: null,
          tax: null,
          total: "field.InvoiceTotal",
          taxNote: null,
          lines: [
            {
              sku: null,
              description: "item.0.Description",
              quantity: "item.0.Quantity",
              uom: "item.0.Unit",
              unitPrice: "item.0.UnitPrice",
              amount: "item.0.Amount",
            },
          ],
        },
        knownIds.map((id) => ({
          id,
          content: id,
          confidence: 1,
          page: 1,
          label: id,
        })),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderError>>({
        stage: "MAPPING_VALIDATION",
        diagnostics: expect.objectContaining({
          unknownIds: "field.UnknownVendor",
        }),
      }),
    );
  });

  it("replaces a low-confidence source only when a reliable equivalent is unique", () => {
    const mapping = {
      vendor: "field.VendorName",
      invoiceNumber: "field.InvoiceId",
      invoiceDate: "field.InvoiceDate",
      poNumber: "field.OrderNumber",
      currency: null,
      subtotal: null,
      tax: null,
      total: "field.InvoiceTotal",
      taxNote: null,
      lines: [
        {
          sku: "item.0.ProductCode",
          description: "item.0.Description",
          quantity: "item.0.Quantity",
          uom: "item.0.Unit",
          unitPrice: "item.0.UnitPrice",
          amount: "item.0.Amount",
        },
      ],
    };
    const values: Record<string, string> = {
      "field.OrderNumber": "PO-1001",
      "item.0.ProductCode": "WID-100",
    };
    const ids = [
      "field.VendorName",
      "field.InvoiceId",
      "field.InvoiceDate",
      "field.OrderNumber",
      "field.InvoiceTotal",
      "item.0.ProductCode",
      "item.0.Description",
      "item.0.Quantity",
      "item.0.Unit",
      "item.0.UnitPrice",
      "item.0.Amount",
    ];
    const evidence: SourceRef[] = ids.map((id) => ({
      id,
      content: values[id] ?? id,
      confidence: id === "field.OrderNumber" || id === "item.0.ProductCode" ? 0.5 : 1,
      page: 1,
      label: id,
      sourceKind: id.startsWith("item") ? ("ITEM" as const) : ("FIELD" as const),
    }));
    evidence.push(
      {
        id: "key_value.0.value",
        content: "PO-1001",
        confidence: 0.94,
        page: 1,
        label: "Key-value value",
        sourceKind: "KEY_VALUE",
      },
      {
        id: "table.0.r1.c0",
        content: "WID-100",
        confidence: null,
        page: 1,
        label: "Table cell",
        sourceKind: "TABLE",
      },
    );

    expect(preferReliableEvidence(mapping, evidence)).toMatchObject({
      poNumber: "key_value.0.value",
      lines: [{ sku: "item.0.ProductCode" }],
    });
  });
});

describe("AI extraction re-checks", () => {
  const mapping = {
    vendor: "field.VendorName",
    invoiceNumber: "field.InvoiceId",
    invoiceDate: "field.InvoiceDate",
    poNumber: null,
    currency: "field.Currency",
    subtotal: null,
    tax: null,
    total: "field.InvoiceTotal",
    taxNote: null,
    lines: [
      {
        sku: "item.0.ProductCode",
        description: "item.0.Description",
        quantity: "item.0.Quantity",
        uom: "item.0.Unit",
        unitPrice: "item.0.UnitPrice",
        amount: "item.0.Amount",
      },
    ],
  };
  const evidence: SourceRef[] = [
    "field.VendorName",
    "field.InvoiceId",
    "field.InvoiceDate",
    "field.Currency",
    "field.InvoiceTotal",
    "item.0.ProductCode",
    "item.0.Description",
    "item.0.Quantity",
    "item.0.Unit",
    "item.0.UnitPrice",
    "item.0.Amount",
  ].map((id) => ({
    id,
    content: id === "item.0.Quantity" ? "8" : id,
    confidence: id === "item.0.Quantity" ? 0.62 : 0.98,
    page: 1,
    label: id,
    sourceKind: id.startsWith("item") ? "ITEM" : "FIELD",
  }));
  async function onePagePdf() {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    return Buffer.from(await pdf.save());
  }

  it("uses one structured page re-read and replaces only the selected low-confidence evidence", async () => {
    const reread = await recheckLowConfidenceFields(await onePagePdf(), evidence, mapping, async (_page, fields) => {
      expect(fields.map((field) => field.field)).toEqual(["lines.0.quantity"]);
      return { "lines.0.quantity": "9" };
    });

    expect(reread.mapping.lines[0]?.quantity).toBe("ai_recheck.lines.0.quantity");
    expect(reread.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ai_recheck.lines.0.quantity",
          content: "9",
          confidence: null,
          sourceKind: "AI_RECHECK",
        }),
      ]),
    );
    expect(reread.aiRechecks).toEqual([
      expect.objectContaining({
        field: "lines.0.quantity",
        originalOcrValue: "8",
        ocrConfidence: 0.62,
        aiValue: "9",
        outcome: "resolved",
      }),
    ]);
    expect(restoreRecheckedMapping(reread.mapping, reread.originalMapping, ["lines.0.quantity"]).lines[0]?.quantity).toBe(
      "item.0.Quantity",
    );
  });

  it("groups fields on the same page and leaves malformed AI answers reviewable without retrying", async () => {
    const lowEvidence = evidence.map((source) => (source.id === "field.VendorName" ? { ...source, confidence: 0.5 } : source));
    let calls = 0;
    const reread = await recheckLowConfidenceFields(await onePagePdf(), lowEvidence, mapping, async (_page, fields) => {
      calls += 1;
      expect(fields).toHaveLength(2);
      return {};
    });

    expect(calls).toBe(1);
    expect(reread.mapping).toMatchObject(mapping);
    expect(reread.aiRechecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "vendor", outcome: "needs_review" }),
        expect.objectContaining({
          field: "lines.0.quantity",
          outcome: "needs_review",
        }),
      ]),
    );
  });

  it("does not guess or call the AI when a low-confidence source has no page", async () => {
    const pageLess = evidence.map((source) => (source.id === "item.0.Quantity" ? { ...source, page: null } : source));
    const reread = await recheckLowConfidenceFields(await onePagePdf(), pageLess, mapping, async () => {
      throw new Error("must not run");
    });

    expect(reread.mapping).toMatchObject(mapping);
    expect(reread.aiRechecks).toEqual([
      expect.objectContaining({
        field: "lines.0.quantity",
        page: null,
        outcome: "needs_review",
      }),
    ]);
  });

  it("turns an explicit AI no-result into empty extraction evidence", async () => {
    const reread = await recheckLowConfidenceFields(await onePagePdf(), evidence, mapping, async () => ({ "lines.0.quantity": null }));

    expect(reread.mapping.lines[0]?.quantity).toBe("ai_recheck.lines.0.quantity");
    expect(reread.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ai_recheck.lines.0.quantity",
          content: "",
          confidence: null,
        }),
      ]),
    );
  });

  it("uses one full-document AI extraction when OCR mapping is missing fields", async () => {
    const incomplete = { ...mapping, vendor: null, poNumber: null, lines: [] };
    let calls = 0;
    const reread = await recheckMissingFieldsWithFullDocument(
      await onePagePdf(),
      evidence,
      incomplete,
      async () => {
        calls += 1;
        return {
          vendor: "Acme Industrial Supplies LLC",
          invoiceNumber: "ACME-2026-001",
          invoiceDate: "2026-07-01",
          poNumber: "PO-1001",
          currency: "USD",
          subtotal: "900.00",
          tax: "90.00",
          total: "990.00",
          taxNote: null,
          lines: [
            {
              sku: "WID-100",
              description: "Industrial Widget",
              quantity: "8",
              uom: "EA",
              unitPrice: "100.00",
              amount: "800.00",
            },
          ],
        };
      },
      "test-model",
    );

    expect(calls).toBe(1);
    expect(reread.mapping).toMatchObject({
      vendor: "ai_full_document.vendor",
      poNumber: "ai_full_document.poNumber",
      lines: [
        {
          sku: "ai_full_document.lines.0.sku",
          quantity: "ai_full_document.lines.0.quantity",
        },
      ],
    });
    expect(reread.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ai_full_document.vendor",
          content: "Acme Industrial Supplies LLC",
          confidence: null,
          page: 1,
          sourceKind: "AI_RECHECK",
        }),
      ]),
    );
    expect(reread.aiRechecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "vendor",
          originalOcrValue: "",
          ocrConfidence: null,
          sourceId: "document",
          aiValue: "Acme Industrial Supplies LLC",
          model: "test-model",
          outcome: "resolved",
        }),
      ]),
    );
  });

  it("records one failed full-document attempt without replacing missing values", async () => {
    const incomplete = { ...mapping, vendor: null, lines: [] };
    let calls = 0;
    const reread = await recheckMissingFieldsWithFullDocument(
      await onePagePdf(),
      evidence,
      incomplete,
      async () => {
        calls += 1;
        throw new Error("malformed response");
      },
      "test-model",
    );

    expect(calls).toBe(1);
    expect(reread.mapping).toMatchObject(incomplete);
    expect(reread.aiRechecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "vendor",
          aiValue: null,
          model: "test-model",
          outcome: "needs_review",
        }),
        expect.objectContaining({ field: "lines", outcome: "needs_review" }),
      ]),
    );
  });

  it("uses the full document when the printed PO is the only missing mapping", async () => {
    const poMissing = { ...mapping, poNumber: null };
    const reread = await recheckMissingFieldsWithFullDocument(await onePagePdf(), evidence, poMissing, async () => ({
      vendor: "Acme Industrial Supplies LLC",
      invoiceNumber: "ACME-2026-001",
      invoiceDate: "2026-07-01",
      poNumber: "PO-1001",
      currency: "USD",
      subtotal: null,
      tax: null,
      total: "990.00",
      taxNote: null,
      lines: [
        {
          sku: "WID-100",
          description: "Industrial Widget",
          quantity: "8",
          uom: "EA",
          unitPrice: "100.00",
          amount: "800.00",
        },
      ],
    }));

    expect(reread.mapping.poNumber).toBe("ai_full_document.poNumber");
    expect(reread.aiRechecks).toEqual([
      expect.objectContaining({
        field: "poNumber",
        page: 1,
        outcome: "resolved",
      }),
    ]);
  });

  it("does not report optional invoice fields that are absent from the document", async () => {
    const poMissing = { ...mapping, poNumber: null };
    const reread = await recheckMissingFieldsWithFullDocument(await onePagePdf(), evidence, poMissing, async () => ({
      vendor: "Acme Industrial Supplies LLC",
      invoiceNumber: "ACME-2026-001",
      invoiceDate: "2026-07-01",
      poNumber: null,
      currency: "USD",
      subtotal: null,
      tax: null,
      total: "990.00",
      taxNote: null,
      lines: [
        {
          sku: "WID-100",
          description: "Industrial Widget",
          quantity: "8",
          uom: "EA",
          unitPrice: "100.00",
          amount: "800.00",
          taxInclusion: null,
          taxRate: null,
          taxAmount: null,
        },
      ],
    }));

    expect(reread.mapping.poNumber).toBeNull();
    expect(reread.aiRechecks).toEqual([]);
  });

  it("does not apply a partial full-document response", async () => {
    const incomplete = { ...mapping, vendor: null, lines: [] };
    const reread = await recheckMissingFieldsWithFullDocument(await onePagePdf(), evidence, incomplete, async () => ({
      vendor: "Acme Industrial Supplies LLC",
      invoiceNumber: "ACME-2026-001",
      invoiceDate: "2026-07-01",
      poNumber: "PO-1001",
      currency: "USD",
      subtotal: null,
      tax: null,
      total: "990.00",
      taxNote: null,
      lines: [],
    }));

    expect(reread.mapping).toMatchObject(incomplete);
    expect(reread.evidence.some((source) => source.id === "ai_full_document.vendor")).toBe(false);
    expect(reread.aiRechecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "vendor",
          aiValue: "Acme Industrial Supplies LLC",
          outcome: "needs_review",
        }),
      ]),
    );
  });
});
