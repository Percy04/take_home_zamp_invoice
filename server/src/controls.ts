import { Decimal } from "decimal.js";
import {
  normalizedInvoiceSchema,
  type Allocation,
  type BundleCandidate,
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
  price_basis: string;
  status: string;
};
type PoLineRow = {
  id: string;
  po_number: string;
  normalized_sku: string | null;
  normalized_description: string;
  description: string;
  uom: string;
  ordered_quantity: string;
  received_quantity: string;
  unit_price: string;
  sku: string | null;
};
type PriorAllocationRow = {
  po_line_id: string;
  component_quantity: string;
  po_basis_amount: string;
};
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

export type ControlContext = {
  vendors: unknown[];
  purchaseOrders: unknown[];
  poLines: unknown[];
  priorAllocations: unknown[];
  postedInvoices: unknown[];
  bundleDefinitions: unknown[];
};

const unsupportedCharge =
  /FREIGHT|SHIPPING|DISCOUNT|CREDIT|RETAINAGE|SPECIAL\s*CHARGE/i;
const unsupportedTax =
  /COMPOUND|EXEMPT|WITHHOLDING|REVERSE[\s-]?CHARGE|RECOVERAB/i;

export function normalizeInvoice(
  evidence: SourceRef[],
  mapping: InvoiceMapping,
): NormalizedInvoice {
  const byId = new Map(evidence.map((source) => [source.id, source]));
  const selected: SourceRef[] = [];
  const fieldSources: Record<string, string> = {};
  const select = (
    id: string | null | undefined,
    required = false,
    field?: string,
    sources = fieldSources,
  ) => {
    if (!id) {
      if (required) failNormalization("MISSING_REQUIRED_FIELD");
      return "";
    }
    const source = byId.get(id);
    if (!source) failNormalization("MAPPING_FAILED");
    selected.push(source);
    if (field) sources[field] = id;
    if (source.confidence !== null && source.confidence < 0.75)
      failNormalization("LOW_CONFIDENCE");
    const value = source.content.normalize("NFKC").trim();
    if (required && !value) failNormalization("MISSING_REQUIRED_FIELD");
    return value;
  };

  for (const source of evidence) {
    if (!unsupportedCharge.test(source.label)) continue;
    const value = parseMoney(source.content, true);
    if (value && !value.isZero()) failNormalization("UNSUPPORTED_STRUCTURE");
  }

  const vendor = select(mapping.vendor, true, "vendor");
  const invoiceNumber = select(mapping.invoiceNumber, true, "invoiceNumber");
  const invoiceDate = parseDate(
    select(mapping.invoiceDate, true, "invoiceDate"),
  );
  const poNumber = select(mapping.poNumber, false, "poNumber");
  if (
    poNumber &&
    poNumber.split(/[,;/\n]|\s+AND\s+/i).filter(Boolean).length > 1
  )
    failNormalization("UNSUPPORTED_STRUCTURE");

  const observedLines = mapping.lines.map((line) => {
    const sourceIds: Record<string, string> = {};
    const sku = select(line.sku, false, "sku", sourceIds);
    const description = select(
      line.description,
      false,
      "description",
      sourceIds,
    );
    if (!sku && !description) failNormalization("MISSING_REQUIRED_FIELD");
    const quantity = parseQuantity(
      select(line.quantity, true, "quantity", sourceIds),
    );
    const uom = parseUom(select(line.uom, true, "uom", sourceIds));
    const observedUnitPrice = requiredMoney(
      select(line.unitPrice, true, "observedUnitPrice", sourceIds),
    );
    const observedAmount = requiredMoney(
      select(line.amount, true, "observedAmount", sourceIds),
    );
    const taxInclusion = select(
      line.taxInclusion,
      false,
      "taxInclusion",
      sourceIds,
    );
    const taxRate = select(line.taxRate, false, "taxRate", sourceIds);
    const observedTaxAmount = optionalMoney(
      select(line.taxAmount, false, "observedTaxAmount", sourceIds),
    );
    if (quantity.mul(observedUnitPrice).minus(observedAmount).abs().gt("0.01"))
      failNormalization("TOTAL_MISMATCH");
    return {
      sku,
      description,
      quantity,
      uom,
      observedUnitPrice,
      observedAmount,
      taxInclusion,
      taxRate,
      observedTaxAmount,
      sourceIds,
    };
  });

  const observedSubtotal = optionalMoney(
    select(mapping.subtotal, false, "observedSubtotal"),
  );
  const observedTax = optionalMoney(select(mapping.tax, false, "observedTax"));
  const observedTotal = requiredMoney(
    select(mapping.total, true, "observedTotal"),
  );
  const taxNote = select(mapping.taxNote, false, "taxNote");
  if (unsupportedTax.test(taxNote)) failNormalization("UNSUPPORTED_STRUCTURE");

  const explicitCurrency = select(
    mapping.currency,
    false,
    "currency",
  ).toUpperCase();
  const moneyText = selected
    .filter((source) => /AMOUNT|PRICE|TOTAL|TAX|SUBTOTAL/i.test(source.label))
    .map((source) => source.content)
    .join(" ");
  const currency = explicitCurrency
    ? explicitCurrency.replace(/\s/g, "")
    : /\$/.test(moneyText) &&
        !/[€£¥]|\b(?:EUR|GBP|JPY|CAD|AUD)\b/i.test(moneyText)
      ? "USD"
      : "";
  if (currency && currency !== "USD")
    failNormalization("UNSUPPORTED_STRUCTURE");
  if (!currency) failNormalization("MISSING_REQUIRED_FIELD");

  const documentInclusionClaim = claimsTaxInclusion(taxNote);
  const documentRate = parseTaxRate(taxNote);
  if (
    (documentInclusionClaim && !documentRate) ||
    (documentRate && !documentInclusionClaim)
  )
    failNormalization("TAX_TREATMENT_UNRESOLVED");

  const lines = observedLines.map((line) => {
    const lineTaxText = `${line.taxInclusion} ${line.taxRate}`.trim();
    const hasLineTaxEvidence = Boolean(line.taxInclusion || line.taxRate);
    const inclusionClaim = hasLineTaxEvidence
      ? claimsTaxInclusion(lineTaxText)
      : documentInclusionClaim;
    const rate = hasLineTaxEvidence ? parseTaxRate(lineTaxText) : documentRate;
    if ((inclusionClaim && !rate) || (rate && !inclusionClaim))
      failNormalization("TAX_TREATMENT_UNRESOLVED");
    const amount = inclusionClaim
      ? money(line.observedAmount.div(new Decimal(1).plus(rate!)))
      : money(line.observedAmount);
    const unitPrice = inclusionClaim
      ? money(new Decimal(amount).div(line.quantity))
      : money(line.observedUnitPrice);
    const taxAmount = inclusionClaim
      ? money(line.observedAmount.minus(amount))
      : money(line.observedTaxAmount ?? 0);
    return {
      sku: line.sku,
      description: line.description,
      quantity: line.quantity.toString(),
      uom: line.uom,
      observedUnitPrice: money(line.observedUnitPrice),
      observedAmount: money(line.observedAmount),
      observedTaxAmount: line.observedTaxAmount
        ? money(line.observedTaxAmount)
        : null,
      unitPrice,
      amount,
      taxAmount,
      taxTreatment: inclusionClaim
        ? ("INCLUSIVE" as const)
        : line.observedTaxAmount?.isZero() === false
          ? ("EXCLUSIVE" as const)
          : ("ZERO" as const),
      taxRate: rate?.toString() ?? null,
      sourceIds: line.sourceIds,
      derivations: inclusionClaim
        ? [
            {
              field: "amount",
              formula: `${money(line.observedAmount)} / (1 + ${rate!.toString()})`,
              sourceIds: [
                line.sourceIds.observedAmount,
                fieldSources.taxNote,
              ].filter((id): id is string => Boolean(id)),
            },
          ]
        : [],
    };
  });
  const goodsSubtotal = lines.reduce(
    (sum, line) => sum.plus(line.amount),
    new Decimal(0),
  );
  if (
    observedSubtotal &&
    observedSubtotal.minus(goodsSubtotal).abs().gt("0.01")
  )
    failNormalization("TOTAL_MISMATCH");

  let taxTreatment: NormalizedInvoice["taxTreatment"];
  let normalizedTax: Decimal;
  const inclusiveLines = lines.filter(
    (line) => line.taxTreatment === "INCLUSIVE",
  );
  const hasInclusiveLines = inclusiveLines.length > 0;
  const hasNonInclusiveLines = inclusiveLines.length < lines.length;
  if (hasInclusiveLines && hasNonInclusiveLines) {
    if (
      lines.some(
        (line) =>
          line.taxTreatment !== "INCLUSIVE" &&
          !line.sourceIds.observedTaxAmount,
      )
    )
      failNormalization("TAX_TREATMENT_UNRESOLVED");
    taxTreatment = "MIXED";
    normalizedTax = lines.reduce(
      (sum, line) => sum.plus(line.taxAmount),
      new Decimal(0),
    );
  } else if (hasInclusiveLines) {
    taxTreatment = "INCLUSIVE";
    normalizedTax = lines.reduce(
      (sum, line) => sum.plus(line.taxAmount),
      new Decimal(0),
    );
    if (observedTax && observedTax.minus(normalizedTax).abs().gt("0.01"))
      failNormalization("TOTAL_MISMATCH");
  } else if (observedTax) {
    taxTreatment = observedTax.isZero() ? "ZERO" : "EXCLUSIVE";
    normalizedTax = observedTax;
  } else if (goodsSubtotal.minus(observedTotal).abs().lte("0.01")) {
    taxTreatment = "ZERO";
    normalizedTax = new Decimal(0);
  } else {
    failNormalization("TAX_TREATMENT_UNRESOLVED");
  }

  if (goodsSubtotal.plus(normalizedTax).minus(observedTotal).abs().gt("0.01"))
    failNormalization("TOTAL_MISMATCH");

  return normalizedInvoiceSchema.parse({
    vendor,
    invoiceNumber,
    invoiceDate,
    poNumber,
    currency: "USD",
    observedSubtotal: observedSubtotal ? money(observedSubtotal) : null,
    observedTax: observedTax ? money(observedTax) : null,
    observedTotal: money(observedTotal),
    taxTreatment,
    taxRate:
      taxTreatment === "INCLUSIVE" &&
      new Set(lines.map((line) => line.taxRate)).size === 1
        ? lines[0]!.taxRate
        : null,
    subtotal: money(goodsSubtotal),
    tax: money(normalizedTax),
    total: money(observedTotal),
    lines,
    fieldSources,
    derivations: hasInclusiveLines
      ? [
          {
            field: "subtotal",
            formula: "Sum of normalized net line amounts",
            sourceIds: lines.flatMap((line) => [line.sourceIds.observedAmount]),
          },
          {
            field: "tax",
            formula: `${money(observedTotal)} - ${money(goodsSubtotal)}`,
            sourceIds: [
              fieldSources.observedTotal,
              fieldSources.taxNote,
            ].filter((id): id is string => Boolean(id)),
          },
        ]
      : [],
  });
}

export function evaluateInvoice(
  invoice: NormalizedInvoice,
  context: ControlContext,
): { checks: CheckResult[]; allocations: Allocation[] } {
  const vendors = context.vendors as VendorRow[];
  const purchaseOrders = context.purchaseOrders as PoRow[];
  const poLines = context.poLines as PoLineRow[];
  const postedInvoices = context.postedInvoices as PostedInvoiceRow[];
  const bundleDefinitions = context.bundleDefinitions as BundleDefinitionRow[];
  const priorAllocations = context.priorAllocations as PriorAllocationRow[];
  const checks: CheckResult[] = [];
  const check = (code: string, passed: boolean, detail: string) => {
    checks.push({ code, passed, detail });
    if (!passed) throw new ControlError(code, detail, [...checks]);
  };

  const vendorMatches = vendors.filter((row) => {
    const names = [
      row.canonical_name,
      ...(JSON.parse(row.aliases_json) as string[]),
    ];
    return names.some((name) => normalize(name) === normalize(invoice.vendor));
  });
  check(
    "VENDOR_MATCH",
    vendorMatches.length === 1,
    "Vendor resolves to one active master record.",
  );
  const vendor = vendorMatches[0]!;
  check(
    "DUPLICATE",
    !postedInvoices.some(
      (row) =>
        row.vendor_id === vendor.id &&
        row.normalized_invoice_number === normalize(invoice.invoiceNumber),
    ),
    "Invoice number has not already been posted for this vendor.",
  );

  const poMatches = purchaseOrders.filter(
    (row) => row.normalized_po_number === normalize(invoice.poNumber),
  );
  check(
    "PO_ELIGIBLE",
    poMatches.length === 1 &&
      poMatches[0]!.vendor_id === vendor.id &&
      poMatches[0]!.status === "OPEN" &&
      poMatches[0]!.currency === invoice.currency,
    "PO is open, USD, and belongs to the vendor.",
  );
  const po = poMatches[0]!;
  check(
    "TAX_BASIS",
    po.price_basis === "TAX_EXCLUSIVE",
    "PO uses the supported tax-exclusive price basis.",
  );

  const used = usedQuantities(priorAllocations);
  const reserved = new Map<string, Decimal>();
  const directVariances: Decimal[] = [];
  const allocations: Allocation[] = [];

  for (const [invoiceLineIndex, line] of invoice.lines.entries()) {
    const matchingPoLines = poLines.filter(
      (row) =>
        row.po_number === po.po_number &&
        row.uom === line.uom &&
        (line.sku
          ? row.normalized_sku === normalize(line.sku)
          : row.normalized_description === normalize(line.description)),
    );
    if (matchingPoLines.length === 1) {
      const poLine = matchingPoLines[0]!;
      const quantity = new Decimal(line.quantity);
      const poPrice = new Decimal(poLine.unit_price);
      const invoicePrice = new Decimal(line.unitPrice);
      const ratio = poPrice.isZero()
        ? invoicePrice.isZero()
          ? new Decimal(0)
          : new Decimal(Infinity)
        : invoicePrice.minus(poPrice).abs().div(poPrice);
      check(
        "PRICE_MATCH",
        ratio.lte("0.01"),
        `${line.sku || line.description} is within the 1% unit-price tolerance.`,
      );
      directVariances.push(invoicePrice.minus(poPrice).abs().mul(quantity));
      allocations.push(
        allocationFor({
          invoiceLineIndex,
          line,
          poLine,
          quantity,
          used,
          reserved,
          matchType: "DIRECT",
          bundleDefinitionId: null,
        }),
      );
      reserve(reserved, poLine.id, quantity);
      continue;
    }

    const bundleMatches = bundleDefinitions.filter(
      (row) =>
        row.active === 1 &&
        row.vendor_id === vendor.id &&
        row.bundle_uom === line.uom &&
        (line.sku
          ? row.normalized_bundle_sku === normalize(line.sku)
          : row.normalized_description === normalize(line.description)),
    );
    check(
      "LINE_MATCH",
      matchingPoLines.length === 0 && bundleMatches.length === 1,
      `${line.sku || line.description} resolves uniquely to a direct line or trusted bundle.`,
    );
    const bundle = bundleMatches[0]!;
    const componentAllocations = (
      JSON.parse(bundle.components_json) as BundleComponent[]
    ).map((component) => {
      if (component.uom !== "EA")
        throw new ControlError(
          "UNSUPPORTED_STRUCTURE",
          "Bundle component UOM conversion is unsupported.",
          [...checks],
        );
      const componentLines = poLines.filter(
        (row) =>
          row.po_number === po.po_number &&
          row.normalized_sku === normalize(component.sku) &&
          row.uom === "EA",
      );
      check(
        "LINE_MATCH",
        componentLines.length === 1,
        `${component.sku} resolves to one PO component.`,
      );
      const quantity = new Decimal(line.quantity).mul(
        component.quantity_per_bundle,
      );
      const allocation = allocationFor({
        invoiceLineIndex,
        line,
        poLine: componentLines[0]!,
        quantity,
        used,
        reserved,
        matchType: "BUNDLE_MASTER",
        bundleDefinitionId: bundle.id,
      });
      reserve(reserved, allocation.poLineId, quantity);
      return allocation;
    });
    const bundleBasis = componentAllocations.reduce(
      (total, row) => total.plus(row.poBasisAmount),
      new Decimal(0),
    );
    check(
      "PRICE_MATCH",
      bundleBasis.minus(line.amount).abs().lte("0.01"),
      `${line.sku || line.description} equals trusted bundle component basis.`,
    );
    allocations.push(...componentAllocations);
  }

  check(
    "PRICE_MATCH",
    directVariances
      .reduce((sum, value) => sum.plus(value), new Decimal(0))
      .lte(5),
    "Aggregate direct-line price variance is at most $5.00.",
  );
  checkCapacities(allocations, checks);
  checkPoValueCapacity(po, poLines, priorAllocations, allocations, checks);

  const lineTotal = invoice.lines.reduce(
    (total, line) => total.plus(line.amount),
    new Decimal(0),
  );
  check(
    "SUBTOTAL_MATCH",
    lineTotal.minus(invoice.subtotal).abs().lte("0.01"),
    "Normalized line amounts equal the subtotal.",
  );
  check(
    "TOTAL_MATCH",
    new Decimal(invoice.subtotal)
      .plus(invoice.tax)
      .minus(invoice.total)
      .abs()
      .lte("0.01"),
    "Subtotal plus tax equals total.",
  );
  return { checks, allocations };
}

export function evaluateConfirmedBundle(
  invoice: NormalizedInvoice,
  candidate: BundleCandidate,
  context: ControlContext,
) {
  const poLines = context.poLines as PoLineRow[];
  const priorAllocations = context.priorAllocations as PriorAllocationRow[];
  const postedInvoices = context.postedInvoices as PostedInvoiceRow[];
  const vendors = context.vendors as VendorRow[];
  const purchaseOrders = context.purchaseOrders as PoRow[];
  const checks: CheckResult[] = [];
  const vendor = vendors.find((row) =>
    [row.canonical_name, ...(JSON.parse(row.aliases_json) as string[])].some(
      (name) => normalize(name) === normalize(invoice.vendor),
    ),
  );
  if (!vendor)
    throw new ControlError(
      "VENDOR_MATCH",
      "Vendor no longer resolves.",
      checks,
    );
  if (
    postedInvoices.some(
      (row) =>
        row.vendor_id === vendor.id &&
        row.normalized_invoice_number === normalize(invoice.invoiceNumber),
    )
  )
    throw new ControlError("DUPLICATE", "Invoice is now a duplicate.", checks);
  const po = purchaseOrders.find(
    (row) =>
      row.normalized_po_number === normalize(invoice.poNumber) &&
      row.vendor_id === vendor.id &&
      row.status === "OPEN" &&
      row.currency === "USD" &&
      row.price_basis === "TAX_EXCLUSIVE",
  );
  if (!po)
    throw new ControlError("PO_ELIGIBLE", "PO is no longer eligible.", checks);

  const used = usedQuantities(priorAllocations);
  const reserved = new Map<string, Decimal>();
  const line = invoice.lines[candidate.invoiceLineIndex];
  if (!line)
    throw new ControlError(
      "LINE_MATCH",
      "Candidate line no longer exists.",
      checks,
    );
  const allocations = candidate.components.map((component) => {
    const poLine = poLines.find(
      (row) => row.id === component.poLineId && row.po_number === po.po_number,
    );
    if (!poLine)
      throw new ControlError(
        "LINE_MATCH",
        "Candidate component no longer exists.",
        checks,
      );
    const quantity = new Decimal(component.quantity);
    const allocation = allocationFor({
      invoiceLineIndex: candidate.invoiceLineIndex,
      line,
      poLine,
      quantity,
      used,
      reserved,
      matchType: "BUNDLE_CONFIRMED",
      bundleDefinitionId: null,
    });
    reserve(reserved, poLine.id, quantity);
    return allocation;
  });
  const basis = allocations.reduce(
    (sum, allocation) => sum.plus(allocation.poBasisAmount),
    new Decimal(0),
  );
  if (basis.minus(line.amount).abs().gt("0.01"))
    throw new ControlError(
      "PRICE_MATCH",
      "Confirmed bundle amount no longer matches.",
      checks,
    );
  checks.push({
    code: "BUNDLE_MAPPING_CONFIRMED",
    passed: true,
    detail: "Reviewer confirmed a stored bundle decomposition.",
  });
  checkCapacities(allocations, checks);
  checkPoValueCapacity(po, poLines, priorAllocations, allocations, checks);
  return { checks, allocations };
}

export function buildUnknownBundleCandidates(
  invoice: NormalizedInvoice,
  poLinesInput: unknown[],
  priorAllocationsInput: unknown[],
): BundleCandidate[] {
  if (invoice.lines.length !== 1) return [];
  const poLines = (poLinesInput as PoLineRow[]).filter(
    (line) => line.po_number === invoice.poNumber && line.uom === "EA",
  );
  if (poLines.length > 10)
    throw new ControlError(
      "UNSUPPORTED_STRUCTURE",
      "Bundle search exceeds ten eligible PO lines.",
      [],
    );
  const used = usedQuantities(priorAllocationsInput as PriorAllocationRow[]);
  const target = new Decimal(invoice.lines[0]!.amount);
  const choices = poLines
    .map((line) => {
      const available = Decimal.min(
        new Decimal(line.ordered_quantity).minus(used.get(line.id) ?? 0),
        new Decimal(line.received_quantity).minus(used.get(line.id) ?? 0),
      );
      const price = new Decimal(line.unit_price);
      const max = price.isZero()
        ? 0
        : Decimal.min(available.floor(), target.div(price).floor()).toNumber();
      return { line, price, max };
    })
    .filter((choice) => choice.max >= 1);
  const found: BundleCandidate["components"][] = [];
  const visit = (
    start: number,
    components: BundleCandidate["components"],
    total: Decimal,
  ) => {
    if (components.length >= 2 && total.minus(target).abs().lte("0.01")) {
      found.push(components);
      return;
    }
    if (components.length === 4 || total.gte(target)) return;
    for (let index = start; index < choices.length; index += 1) {
      const choice = choices[index]!;
      for (let quantity = 1; quantity <= choice.max; quantity += 1) {
        const amount = choice.price.mul(quantity);
        if (total.plus(amount).gt(target.plus("0.01"))) break;
        visit(
          index + 1,
          [
            ...components,
            {
              poLineId: choice.line.id,
              sku: choice.line.sku ?? "",
              uom: "EA",
              quantity: String(quantity),
              poBasisAmount: money(amount),
            },
          ],
          total.plus(amount),
        );
      }
    }
  };
  visit(0, [], new Decimal(0));
  return found
    .sort(
      (left, right) =>
        left.length - right.length ||
        candidateKey(left).localeCompare(candidateKey(right)),
    )
    .slice(0, 3)
    .map((components, index) => ({
      id: `BUNDLE-CANDIDATE-${index + 1}`,
      invoiceLineIndex: 0,
      bundleQuantity: invoice.lines[0]!.quantity,
      totalPoBasisAmount: money(
        components.reduce(
          (sum, component) => sum.plus(component.poBasisAmount),
          new Decimal(0),
        ),
      ),
      components,
    }));
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

export class NormalizationError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
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
  reserved: Map<string, Decimal>;
  matchType: Allocation["matchType"];
  bundleDefinitionId: string | null;
}): Allocation {
  const basis = input.quantity.mul(input.poLine.unit_price);
  const consumed = (input.used.get(input.poLine.id) ?? new Decimal(0)).plus(
    input.reserved.get(input.poLine.id) ?? 0,
  );
  const orderedRemaining = new Decimal(input.poLine.ordered_quantity)
    .minus(consumed)
    .minus(input.quantity);
  const receivedRemaining = new Decimal(input.poLine.received_quantity)
    .minus(consumed)
    .minus(input.quantity);
  const actualNetAmount =
    input.matchType === "DIRECT" ? input.line.amount : money(basis);
  return {
    invoiceLineIndex: input.invoiceLineIndex,
    poLineId: input.poLine.id,
    poNumber: input.poLine.po_number,
    sku: input.poLine.sku ?? "",
    quantity: input.quantity.toString(),
    matchType: input.matchType,
    bundleDefinitionId: input.bundleDefinitionId,
    poBasisAmount: money(basis),
    actualNetAmount,
    remainingOrderedQuantity: orderedRemaining.toString(),
    remainingReceivedQuantity: receivedRemaining.toString(),
    matchReason:
      input.matchType === "DIRECT"
        ? "Matched invoice line to PO line by exact SKU, description, and UOM."
        : input.matchType === "BUNDLE_MASTER"
          ? "Expanded from a trusted vendor bundle definition."
          : "Expanded from the reviewer-confirmed bundle decomposition.",
    priceVariance: money(new Decimal(actualNetAmount).minus(basis)),
    sourceIds: Object.values(input.line.sourceIds),
  };
}

function checkCapacities(allocations: Allocation[], checks: CheckResult[]) {
  const receiptPasses = allocations.every((row) =>
    new Decimal(row.remainingReceivedQuantity).gte(0),
  );
  checks.push({
    code: "RECEIPT_CAPACITY",
    passed: receiptPasses,
    detail: "Allocated quantities fit remaining receipts.",
  });
  if (!receiptPasses)
    throw new ControlError(
      "RECEIPT_CAPACITY",
      "Quantity exceeds received capacity.",
      checks,
    );
  const orderPasses = allocations.every((row) =>
    new Decimal(row.remainingOrderedQuantity).gte(0),
  );
  checks.push({
    code: "ORDERED_CAPACITY",
    passed: orderPasses,
    detail: "Allocated quantities fit remaining ordered capacity.",
  });
  if (!orderPasses)
    throw new ControlError(
      "ORDERED_CAPACITY",
      "Quantity exceeds ordered capacity.",
      checks,
    );
}

function checkPoValueCapacity(
  po: PoRow,
  poLines: PoLineRow[],
  prior: PriorAllocationRow[],
  current: Allocation[],
  checks: CheckResult[],
) {
  const total = poLines
    .filter((line) => line.po_number === po.po_number)
    .reduce(
      (sum, line) =>
        sum.plus(new Decimal(line.ordered_quantity).mul(line.unit_price)),
      new Decimal(0),
    );
  const lineIds = new Set(
    poLines
      .filter((line) => line.po_number === po.po_number)
      .map((line) => line.id),
  );
  const priorBasis = prior
    .filter((row) => lineIds.has(row.po_line_id))
    .reduce((sum, row) => sum.plus(row.po_basis_amount), new Decimal(0));
  const currentBasis = current.reduce(
    (sum, row) => sum.plus(row.poBasisAmount),
    new Decimal(0),
  );
  const passed = priorBasis.plus(currentBasis).lte(total);
  checks.push({
    code: "PO_VALUE_CAPACITY",
    passed,
    detail: "PO-basis value fits remaining ordered value.",
  });
  if (!passed)
    throw new ControlError(
      "ORDERED_CAPACITY",
      "PO value capacity is exceeded.",
      checks,
    );
}

function usedQuantities(rows: PriorAllocationRow[]) {
  const used = new Map<string, Decimal>();
  for (const row of rows)
    used.set(
      row.po_line_id,
      (used.get(row.po_line_id) ?? new Decimal(0)).plus(row.component_quantity),
    );
  return used;
}

function reserve(map: Map<string, Decimal>, id: string, quantity: Decimal) {
  map.set(id, (map.get(id) ?? new Decimal(0)).plus(quantity));
}

function requiredMoney(value: string) {
  const parsed = parseMoney(value, false);
  if (!parsed) failNormalization("MISSING_REQUIRED_FIELD");
  return parsed;
}

function optionalMoney(value: string) {
  return value ? parseMoney(value, false) : null;
}

function parseMoney(value: string, allowUnparseable: boolean) {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return null;
  if (/^\(.*\)$/.test(normalized) || /-/.test(normalized))
    failNormalization("UNSUPPORTED_STRUCTURE");
  const stripped = normalized
    .replace(/^USD\s*/i, "")
    .replace(/^\$\s*/, "")
    .replace(/,/g, "")
    .trim();
  if (!/^\d+(?:\.\d+)?$/.test(stripped)) {
    if (allowUnparseable) return null;
    failNormalization("MISSING_REQUIRED_FIELD");
  }
  return new Decimal(stripped);
}

function parseQuantity(value: string) {
  const stripped = value.replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(stripped))
    failNormalization("MISSING_REQUIRED_FIELD");
  const quantity = new Decimal(stripped);
  if (quantity.lte(0)) failNormalization("UNSUPPORTED_STRUCTURE");
  return quantity;
}

function parseUom(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (["EA", "EACH", "PC", "PCS"].includes(normalized)) return "EA";
  if (normalized === "KIT") return "KIT";
  if (!normalized) failNormalization("MISSING_REQUIRED_FIELD");
  return normalized;
}

function parseDate(value: string) {
  const normalized = value.trim();
  let year: number;
  let month: number;
  let day: number;
  let match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) [, year, month, day] = match.map(Number);
  else if ((match = normalized.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)))
    [, month, day, year] = match.map(Number);
  else {
    const parsed = normalized.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
    if (!parsed) failNormalization("MISSING_REQUIRED_FIELD");
    const monthIndex = [
      "JANUARY",
      "FEBRUARY",
      "MARCH",
      "APRIL",
      "MAY",
      "JUNE",
      "JULY",
      "AUGUST",
      "SEPTEMBER",
      "OCTOBER",
      "NOVEMBER",
      "DECEMBER",
    ].findIndex((name) => name.startsWith(parsed[1]!.toUpperCase()));
    if (monthIndex < 0) failNormalization("MISSING_REQUIRED_FIELD");
    year = Number(parsed[3]);
    month = monthIndex + 1;
    day = Number(parsed[2]);
  }
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    date.getUTCFullYear() !== year! ||
    date.getUTCMonth() + 1 !== month! ||
    date.getUTCDate() !== day!
  )
    failNormalization("MISSING_REQUIRED_FIELD");
  return `${String(year!).padStart(4, "0")}-${String(month!).padStart(2, "0")}-${String(day!).padStart(2, "0")}`;
}

function parseTaxRate(value: string) {
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
  if (!matches.length) return null;
  const rates = new Set(matches.map((match) => match[1]));
  if (rates.size > 1) failNormalization("TAX_TREATMENT_UNRESOLVED");
  const rate = new Decimal(matches[0]![1]!).div(100);
  if (rate.lte(0) || rate.gte(1)) failNormalization("TAX_TREATMENT_UNRESOLVED");
  return rate;
}

function claimsTaxInclusion(value: string) {
  return /INCLUD(?:E|ES|ED|ING).*?(?:TAX|VAT|GST)|(?:TAX|VAT|GST).*?INCLUD/i.test(
    value,
  );
}

function money(value: Decimal.Value) {
  return new Decimal(value)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

function candidateKey(components: BundleCandidate["components"]) {
  return components
    .map((component) => `${component.poLineId}:${component.quantity}`)
    .join("|");
}

function failNormalization(reasonCode: string): never {
  throw new NormalizationError(reasonCode);
}
