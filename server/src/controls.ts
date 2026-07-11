import { Decimal } from "decimal.js";
import {
  normalizedInvoiceSchema,
  type Allocation,
  type CheckResult,
  type NormalizedInvoice,
  type SourceRef,
} from "../../shared/contracts.js";
import type { InvoiceMapping } from "./providers.js";

type VendorRow = {
  id: string;
  canonical_name: string;
  normalized_name: string;
  aliases_json: string;
};
type PoRow = {
  po_number: string;
  normalized_po_number: string;
  vendor_id: string;
  currency: string;
  status: string;
};
type PoLineRow = {
  id: string;
  po_number: string;
  normalized_sku: string;
  normalized_description: string;
  uom: string;
  ordered_quantity: string;
  received_quantity: string;
  unit_price: string;
  sku: string;
};
type UsedRow = { po_line_id: string; quantity: number };

export function normalizeInvoice(
  evidence: SourceRef[],
  mapping: InvoiceMapping,
): NormalizedInvoice {
  const byId = new Map(evidence.map((source) => [source.id, source]));
  const select = (id: string) => {
    const source = byId.get(id);
    if (!source) throw new Error(`Missing evidence ${id}`);
    return source.content.normalize("NFKC").trim();
  };
  const money = (id: string) =>
    new Decimal(select(id).replace(/[$,\s]/g, "")).toFixed(2);

  return normalizedInvoiceSchema.parse({
    vendor: select(mapping.vendor),
    invoiceNumber: select(mapping.invoiceNumber),
    invoiceDate: select(mapping.invoiceDate),
    poNumber: select(mapping.poNumber),
    currency: select(mapping.currency),
    subtotal: money(mapping.subtotal),
    tax: money(mapping.tax),
    total: money(mapping.total),
    lines: mapping.lines.map((line) => ({
      sku: select(line.sku),
      description: select(line.description),
      quantity: new Decimal(select(line.quantity)).toString(),
      uom: select(line.uom).toUpperCase(),
      unitPrice: money(line.unitPrice),
      amount: money(line.amount),
    })),
  });
}

export function evaluateHappyPath(
  invoice: NormalizedInvoice,
  context: {
    vendors: unknown[];
    purchaseOrders: unknown[];
    poLines: unknown[];
    usedQuantities: unknown[];
  },
): { checks: CheckResult[]; allocations: Allocation[] } {
  const vendors = context.vendors as VendorRow[];
  const purchaseOrders = context.purchaseOrders as PoRow[];
  const poLines = context.poLines as PoLineRow[];
  const used = new Map(
    (context.usedQuantities as UsedRow[]).map((row) => [
      row.po_line_id,
      new Decimal(row.quantity),
    ]),
  );
  const checks: CheckResult[] = [];
  const check = (code: string, passed: boolean, detail: string) => {
    checks.push({ code, passed, detail });
    if (!passed) throw new ControlError(code, detail, checks);
  };

  const vendor = vendors.find((row) => {
    const names = [
      row.canonical_name,
      ...(JSON.parse(row.aliases_json) as string[]),
    ];
    return names.some((name) => normalize(name) === normalize(invoice.vendor));
  });
  check("VENDOR_MATCH", Boolean(vendor), "Vendor is approved and active.");
  const po = purchaseOrders.find(
    (row) =>
      row.normalized_po_number === normalize(invoice.poNumber) &&
      row.vendor_id === vendor!.id,
  );
  check(
    "PO_ELIGIBLE",
    Boolean(po && po.status === "OPEN" && po.currency === invoice.currency),
    "PO is open, USD, and belongs to the vendor.",
  );

  const allocations = invoice.lines.map((line) => {
    const poLine = poLines.find(
      (row) =>
        row.po_number === po!.po_number &&
        row.normalized_sku === normalize(line.sku) &&
        row.normalized_description === normalize(line.description) &&
        row.uom === line.uom,
    );
    check(
      "LINE_MATCH",
      Boolean(poLine),
      `${line.sku} matches one PO line exactly.`,
    );
    const quantity = new Decimal(line.quantity);
    const basis = quantity.mul(poLine!.unit_price);
    check(
      "PRICE_MATCH",
      basis.eq(line.amount),
      `${line.sku} amount equals PO price × quantity.`,
    );
    const consumed = used.get(poLine!.id) ?? new Decimal(0);
    const orderedRemaining = new Decimal(poLine!.ordered_quantity)
      .minus(consumed)
      .minus(quantity);
    const receivedRemaining = new Decimal(poLine!.received_quantity)
      .minus(consumed)
      .minus(quantity);
    check(
      "ORDERED_CAPACITY",
      orderedRemaining.gte(0),
      `${line.sku} is within ordered quantity.`,
    );
    check(
      "RECEIPT_CAPACITY",
      receivedRemaining.gte(0),
      `${line.sku} is within received quantity.`,
    );
    return {
      poLineId: poLine!.id,
      sku: poLine!.sku,
      quantity: quantity.toString(),
      poBasisAmount: basis.toFixed(2),
      actualNetAmount: line.amount,
      remainingOrderedQuantity: orderedRemaining.toString(),
      remainingReceivedQuantity: receivedRemaining.toString(),
    };
  });
  const lineTotal = allocations.reduce(
    (total, row) => total.plus(row.actualNetAmount),
    new Decimal(0),
  );
  check(
    "SUBTOTAL_MATCH",
    lineTotal.eq(invoice.subtotal),
    "Line amounts equal the invoice subtotal.",
  );
  check(
    "TOTAL_MATCH",
    new Decimal(invoice.subtotal).plus(invoice.tax).eq(invoice.total),
    "Subtotal plus tax equals the invoice total.",
  );
  return { checks, allocations };
}

export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly checks: CheckResult[],
  ) {
    super(message);
  }
}

export function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
