import { readFile } from "node:fs/promises";
import path from "node:path";
import { sourceRefSchema, type SourceRef } from "../../shared/contracts.js";

export type InvoiceMapping = {
  vendor: string;
  invoiceNumber: string;
  invoiceDate: string;
  poNumber: string;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  lines: Array<{
    sku: string;
    description: string;
    quantity: string;
    uom: string;
    unitPrice: string;
    amount: string;
  }>;
};

export async function extractAndMapRecorded(): Promise<{
  evidence: SourceRef[];
  mapping: InvoiceMapping;
}> {
  const raw = JSON.parse(
    await readFile(path.resolve("data/recordings/happy_sources.json"), "utf8"),
  ) as unknown;
  const evidence = sourceRefSchema.array().parse(raw);
  const mapping: InvoiceMapping = {
    vendor: "field.VendorName",
    invoiceNumber: "field.InvoiceId",
    invoiceDate: "field.InvoiceDate",
    poNumber: "field.PurchaseOrder",
    currency: "line.1.l9",
    subtotal: "field.SubTotal",
    tax: "field.TotalTax",
    total: "field.InvoiceTotal",
    lines: [0, 1].map((index) => ({
      sku: `item.${index}.ProductCode`,
      description: `item.${index}.Description`,
      quantity: `item.${index}.Quantity`,
      uom: `item.${index}.Unit`,
      unitPrice: `item.${index}.UnitPrice`,
      amount: `item.${index}.Amount`,
    })),
  };
  return { evidence, mapping };
}
