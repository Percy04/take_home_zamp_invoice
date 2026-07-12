import { describe, expect, it } from "vitest";
import {
  buildSourceCatalogue,
  ProviderError,
  validateMapping,
} from "../server/src/providers.js";

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
});
