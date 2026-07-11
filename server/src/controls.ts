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
type PostedInvoiceRow = {
  vendor_id: string;
  normalized_invoice_number: string;
};
type BundleDefinitionRow = {
  id: string;
  vendor_id: string;
  normalized_bundle_sku: string | null;
  normalized_description: string | null;
  bundle_uom: string;
  components_json: string;
  active: number;
};
type BundleComponent = {
  sku: string;
  quantity_per_bundle: string;
  uom: string;
};

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
  const money = (id: string) => moneyValue(select(id));
  const taxRate =
    mapping.taxNote && !mapping.subtotal && !mapping.tax
      ? inclusiveTaxRate(select(mapping.taxNote))
      : null;
  const total = money(mapping.total);
  const inclusiveSubtotal = taxRate
    ? new Decimal(total).div(new Decimal(1).plus(taxRate)).toFixed(2)
    : null;
  const subtotal = inclusiveSubtotal ?? (mapping.subtotal ? money(mapping.subtotal) : null);
  const tax = taxRate
    ? new Decimal(total).minus(inclusiveSubtotal!).toFixed(2)
    : mapping.tax
      ? money(mapping.tax)
      : null;
  if (!subtotal || !tax) throw new Error("Missing tax fields");

  return normalizedInvoiceSchema.parse({
    vendor: select(mapping.vendor),
    invoiceNumber: select(mapping.invoiceNumber),
    invoiceDate: select(mapping.invoiceDate),
    poNumber: select(mapping.poNumber),
    currency: select(mapping.currency),
    subtotal,
    tax,
    total,
    lines: mapping.lines.map((line) => ({
      sku: select(line.sku),
      description: select(line.description),
      quantity: new Decimal(select(line.quantity)).toString(),
      uom: select(line.uom).toUpperCase(),
      unitPrice: taxRate
        ? new Decimal(money(line.unitPrice))
            .div(new Decimal(1).plus(taxRate))
            .toFixed(2)
        : money(line.unitPrice),
      amount: taxRate
        ? new Decimal(money(line.amount))
            .div(new Decimal(1).plus(taxRate))
            .toFixed(2)
        : money(line.amount),
    })),
  });
}

export function evaluateInvoice(
  invoice: NormalizedInvoice,
  context: {
    vendors: unknown[];
    purchaseOrders: unknown[];
    poLines: unknown[];
    usedQuantities: unknown[];
    postedInvoices: unknown[];
    bundleDefinitions: unknown[];
  },
): { checks: CheckResult[]; allocations: Allocation[] } {
  const vendors = context.vendors as VendorRow[];
  const purchaseOrders = context.purchaseOrders as PoRow[];
  const poLines = context.poLines as PoLineRow[];
  const postedInvoices = context.postedInvoices as PostedInvoiceRow[];
  const bundleDefinitions = context.bundleDefinitions as BundleDefinitionRow[];
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
  check(
    "DUPLICATE",
    !postedInvoices.some(
      (row) =>
        row.vendor_id === vendor!.id &&
        row.normalized_invoice_number === normalize(invoice.invoiceNumber),
    ),
    "Invoice number has not already been posted for this vendor.",
  );

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

  const allocations = invoice.lines.flatMap((line, invoiceLineIndex) => {
    const poLine = poLines.find(
      (row) =>
        row.po_number === po!.po_number &&
        row.normalized_sku === normalize(line.sku) &&
        row.normalized_description === normalize(line.description) &&
        row.uom === line.uom,
    );
    if (!poLine) {
      const bundle = bundleDefinitions.find(
        (row) =>
          row.active === 1 &&
          row.vendor_id === vendor!.id &&
          row.bundle_uom === line.uom &&
          (row.normalized_bundle_sku === normalize(line.sku) ||
            row.normalized_description === normalize(line.description)),
      );
      check(
        "LINE_MATCH",
        Boolean(bundle),
        `${line.sku || line.description} matches a direct PO line or trusted bundle.`,
      );
      const componentAllocations = (
        JSON.parse(bundle!.components_json) as BundleComponent[]
      ).map((component) => {
        const componentLine = poLines.find(
          (row) =>
            row.po_number === po!.po_number &&
            row.normalized_sku === normalize(component.sku) &&
            row.uom === component.uom,
        );
        check(
          "LINE_MATCH",
          Boolean(componentLine),
          `${component.sku} matches one PO component line.`,
        );
        return allocationFor({
          invoiceLineIndex,
          line,
          poLine: componentLine!,
          quantity: new Decimal(line.quantity).mul(
            component.quantity_per_bundle,
          ),
          used,
          matchType: "BUNDLE_MASTER",
          bundleDefinitionId: bundle!.id,
        });
      });
      const bundleBasis = componentAllocations.reduce(
        (total, row) => total.plus(row.poBasisAmount),
        new Decimal(0),
      );
      check(
        "PRICE_MATCH",
        bundleBasis.eq(line.amount),
        `${line.sku || line.description} equals trusted bundle component basis.`,
      );
      return componentAllocations;
    }

    const quantity = new Decimal(line.quantity);
    const basis = quantity.mul(poLine.unit_price);
    check(
      "PRICE_MATCH",
      basis.eq(line.amount),
      `${line.sku} amount equals PO price x quantity.`,
    );
    return [
      allocationFor({
        invoiceLineIndex,
        line,
        poLine,
        quantity,
        used,
        matchType: "DIRECT",
        bundleDefinitionId: null,
      }),
    ];
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

export const evaluateHappyPath = evaluateInvoice;

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

function allocationFor(input: {
  invoiceLineIndex: number;
  line: NormalizedInvoice["lines"][number];
  poLine: PoLineRow;
  quantity: Decimal;
  used: Map<string, Decimal>;
  matchType: Allocation["matchType"];
  bundleDefinitionId: string | null;
}): Allocation {
  const basis = input.quantity.mul(input.poLine.unit_price);
  const consumed = input.used.get(input.poLine.id) ?? new Decimal(0);
  const orderedRemaining = new Decimal(input.poLine.ordered_quantity)
    .minus(consumed)
    .minus(input.quantity);
  const receivedRemaining = new Decimal(input.poLine.received_quantity)
    .minus(consumed)
    .minus(input.quantity);
  if (orderedRemaining.lt(0))
    throw new ControlError(
      "ORDERED_CAPACITY",
      "Quantity exceeds ordered capacity.",
      [],
    );
  if (receivedRemaining.lt(0))
    throw new ControlError(
      "RECEIPT_CAPACITY",
      "Quantity exceeds received capacity.",
      [],
    );
  return {
    invoiceLineIndex: input.invoiceLineIndex,
    poLineId: input.poLine.id,
    poNumber: input.poLine.po_number,
    sku: input.poLine.sku,
    quantity: input.quantity.toString(),
    matchType: input.matchType,
    bundleDefinitionId: input.bundleDefinitionId,
    poBasisAmount: basis.toFixed(2),
    actualNetAmount:
      input.matchType === "DIRECT" ? input.line.amount : basis.toFixed(2),
    remainingOrderedQuantity: orderedRemaining.toString(),
    remainingReceivedQuantity: receivedRemaining.toString(),
  };
}

function moneyValue(value: string) {
  return new Decimal(value.replace(/[$,\s]/g, "")).toFixed(2);
}

function inclusiveTaxRate(value: string) {
  const match = value.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? new Decimal(match[1]).div(100) : null;
}
