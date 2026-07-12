import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  buildSourceCatalogue,
  extractAndMap,
  invoiceMappingSchemaForEvidence,
  preferReliableEvidence,
  ProviderError,
  validateMapping,
} from "../server/src/providers.js";
import type { SourceRef } from "../shared/contracts.js";

describe("recorded provider", () => {
  it("rejects an unrecognised PDF instead of substituting a fixture", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();

    await expect(
      extractAndMap(Buffer.from(await pdf.save())),
    ).rejects.toMatchObject({
      stage: "RECORDED_PROVIDER",
    });
  });
});

describe("Azure evidence catalogue", () => {
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
            lines: [
              { content: "Total $590.00", spans: [{ offset: 10, length: 13 }] },
            ],
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

    expect(
      schema.safeParse({
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
      }).success,
    ).toBe(false);
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
      confidence:
        id === "field.OrderNumber" || id === "item.0.ProductCode" ? 0.5 : 1,
      page: 1,
      label: id,
      sourceKind: id.startsWith("item")
        ? ("ITEM" as const)
        : ("FIELD" as const),
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
      lines: [{ sku: "table.0.r1.c0" }],
    });
  });
});
