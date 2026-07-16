import { Decimal } from "decimal.js";
import {
  type Allocation,
  type BundleCandidate,
  type CheckResult,
  type NormalizedInvoice,
} from "../../shared/contracts.js";

export type VendorRow = {
  id: string;
  canonical_name: string;
  aliases_json: string;
};
export type PoRow = {
  po_number: string;
  normalized_po_number: string;
  vendor_id: string;
  currency: string;
  price_basis: string;
  status: string;
};
export type PoLineRow = {
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
export type PriorAllocationRow = {
  po_line_id: string;
  component_quantity: string;
  po_basis_amount: string;
};
export type PostedInvoiceRow = {
  vendor_id: string;
  normalized_invoice_number: string;
};
export type BundleDefinitionRow = {
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
  vendors: VendorRow[];
  purchaseOrders: PoRow[];
  poLines: PoLineRow[];
  priorAllocations: PriorAllocationRow[];
  postedInvoices: PostedInvoiceRow[];
  bundleDefinitions: BundleDefinitionRow[];
};

export function evaluateDuplicate(
  invoice: NormalizedInvoice,
  context: Pick<ControlContext, "vendors" | "postedInvoices">,
) {
  const vendorMatches = resolveVendorMatches(invoice.vendor, context.vendors);
  const vendor = vendorMatches.length === 1 ? vendorMatches[0]! : null;
  const duplicate = Boolean(
    vendor &&
    context.postedInvoices.some(
      (row) =>
        row.vendor_id === vendor.id &&
        row.normalized_invoice_number === normalize(invoice.invoiceNumber),
    ),
  );
  return {
    vendor,
    check: {
      code: "DUPLICATE",
      passed: !duplicate,
      detail: "Invoice number has not already been posted for this vendor.",
      category: "DUPLICATE" as const,
      expected: "A new invoice number for this vendor",
      actual: invoice.invoiceNumber,
      sourceIds: [invoice.fieldSources.invoiceNumber].filter(Boolean),
    },
  };
}

export function evaluateInvoice(
  invoice: NormalizedInvoice,
  context: ControlContext,
): { checks: CheckResult[]; allocations: Allocation[] } {
  const {
    vendors,
    purchaseOrders,
    poLines,
    bundleDefinitions,
    priorAllocations,
  } = context;
  const checks: CheckResult[] = [];
  const record = (
    code: string,
    passed: boolean,
    detail: string,
    metadata: Partial<CheckResult> = {},
  ) => {
    checks.push({ ...metadata, code, passed, detail });
  };
  const gate = (
    code: string,
    passed: boolean,
    detail: string,
    metadata: Partial<CheckResult> = {},
  ) => {
    record(code, passed, detail, metadata);
    if (!passed) throw new ControlError(code, detail, [...checks]);
  };

  const vendorMatches = resolveVendorMatches(invoice.vendor, vendors);
  gate(
    "VENDOR_MATCH",
    vendorMatches.length === 1,
    "Vendor resolves to one active master record.",
  );
  const vendor = vendorMatches[0]!;
  const duplicate = evaluateDuplicate(invoice, context);
  gate(
    "DUPLICATE",
    duplicate.check.passed,
    duplicate.check.detail,
    duplicate.check,
  );
  gate(
    "MISSING_PO",
    Boolean(invoice.poNumber),
    "Invoice includes a PO reference.",
  );

  const poMatches = purchaseOrders.filter(
    (row) => row.normalized_po_number === normalize(invoice.poNumber),
  );
  gate(
    "PO_ELIGIBLE",
    poMatches.length === 1 &&
      poMatches[0]!.vendor_id === vendor.id &&
      poMatches[0]!.status === "OPEN" &&
      poMatches[0]!.currency === invoice.currency,
    "PO is open, USD, and belongs to the vendor.",
  );
  const po = poMatches[0]!;
  gate(
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
      const variance = invoicePrice.minus(poPrice).abs();
      const pricePasses = ratio.lte("0.01");
      record(
        "PRICE_MATCH",
        pricePasses,
        pricePasses
          ? `${line.sku || line.description} is within the 1% unit-price tolerance.`
          : `${line.sku || line.description}: invoice $${money(invoicePrice)} per ${line.uom}; PO $${money(poPrice)}; variance ${poPrice.isZero() ? "not applicable" : `${money(ratio.mul(100))}%`} (1.00% tolerance).`,
        {
          category: "MATCHING",
          expected: `$${money(poPrice)} per ${line.uom}`,
          actual: `$${money(invoicePrice)} per ${line.uom}`,
          sourceIds: Object.values(line.sourceIds),
          ...(pricePasses
            ? {}
            : {
                calculation: {
                  kind: "PRICE_VARIANCE" as const,
                  sku: line.sku || line.description,
                  uom: line.uom,
                  quantity: line.quantity,
                  invoiceUnitPrice: money(invoicePrice),
                  poUnitPrice: money(poPrice),
                  varianceAmount: money(variance.mul(quantity)),
                  variancePercent: poPrice.isZero()
                    ? "N/A"
                    : money(ratio.mul(100)),
                  tolerancePercent: "1.00",
                },
              }),
        },
      );
      directVariances.push(variance.mul(quantity));
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
    gate(
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
      gate(
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
    record(
      "PRICE_MATCH",
      bundleBasis.minus(line.amount).abs().lte("0.01"),
      `${line.sku || line.description} equals trusted bundle component basis.`,
    );
    allocations.push(...componentAllocations);
  }

  record(
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
  record(
    "SUBTOTAL_MATCH",
    lineTotal.minus(invoice.subtotal).abs().lte("0.01"),
    "Normalized line amounts equal the subtotal.",
  );
  record(
    "TOTAL_MATCH",
    new Decimal(invoice.subtotal)
      .plus(invoice.tax)
      .minus(invoice.total)
      .abs()
      .lte("0.01"),
    "Subtotal plus tax equals total.",
  );
  throwForFailedControls(checks);
  return { checks, allocations };
}

export function evaluateConfirmedBundle(
  invoice: NormalizedInvoice,
  candidate: BundleCandidate,
  context: ControlContext,
) {
  const { poLines, priorAllocations, vendors, purchaseOrders } = context;
  const checks: CheckResult[] = [];
  const vendor = resolveVendorMatches(invoice.vendor, vendors)[0];
  if (!vendor)
    throw new ControlError(
      "VENDOR_MATCH",
      "Vendor no longer resolves.",
      checks,
    );
  const duplicate = evaluateDuplicate(invoice, context);
  if (!duplicate.check.passed)
    throw new ControlError("DUPLICATE", duplicate.check.detail, [
      duplicate.check,
    ]);
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
  checks.push({
    code: "PRICE_MATCH",
    passed: basis.minus(line.amount).abs().lte("0.01"),
    detail: "Confirmed bundle amount matches the current PO basis.",
  });
  checks.push({
    code: "BUNDLE_MAPPING_CONFIRMED",
    passed: true,
    detail: "Reviewer confirmed a stored bundle decomposition.",
  });
  checkCapacities(allocations, checks);
  checkPoValueCapacity(po, poLines, priorAllocations, allocations, checks);
  throwForFailedControls(checks);
  return { checks, allocations };
}

export function buildUnknownBundleCandidates(
  invoice: NormalizedInvoice,
  poLinesInput: PoLineRow[],
  priorAllocationsInput: PriorAllocationRow[],
): BundleCandidate[] {
  if (invoice.lines.length !== 1) return [];
  const poLines = poLinesInput.filter(
    (line) => line.po_number === invoice.poNumber && line.uom === "EA",
  );
  if (poLines.length > 10)
    throw new ControlError(
      "UNSUPPORTED_STRUCTURE",
      "Bundle search exceeds ten eligible PO lines.",
      [],
    );
  const used = usedQuantities(priorAllocationsInput);
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
              description: choice.line.description,
              unitPrice: choice.line.unit_price,
              availableOrderedQuantity: new Decimal(
                choice.line.ordered_quantity,
              )
                .minus(used.get(choice.line.id) ?? 0)
                .toString(),
              availableReceivedQuantity: new Decimal(
                choice.line.received_quantity,
              )
                .minus(used.get(choice.line.id) ?? 0)
                .toString(),
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

function resolveVendorMatches(vendor: string, vendors: VendorRow[]) {
  return vendors.filter((row) =>
    [row.canonical_name, ...(JSON.parse(row.aliases_json) as string[])].some(
      (name) => normalize(name) === normalize(vendor),
    ),
  );
}

function throwForFailedControls(checks: CheckResult[]) {
  const failed = checks.filter((check) => !check.passed);
  if (!failed.length) return;
  const independentCodes = [...new Set(failed.map((check) => check.code))];
  const first = failed[0]!;
  if (independentCodes.length > 1)
    throw new ControlError(
      "MULTIPLE_ISSUES",
      `${independentCodes.length} independent controls failed.`,
      checks,
    );
  throw new ControlError(first.code, first.detail, checks);
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
  const availableOrderedQuantity = new Decimal(input.poLine.ordered_quantity)
    .minus(consumed)
    .toString();
  const availableReceivedQuantity = new Decimal(input.poLine.received_quantity)
    .minus(consumed)
    .toString();
  const actualNetAmount =
    input.matchType === "DIRECT" ? input.line.amount : money(basis);
  return {
    invoiceLineIndex: input.invoiceLineIndex,
    poLineId: input.poLine.id,
    poNumber: input.poLine.po_number,
    sku: input.poLine.sku ?? "",
    uom: input.line.uom,
    quantity: input.quantity.toString(),
    matchType: input.matchType,
    bundleDefinitionId: input.bundleDefinitionId,
    poBasisAmount: money(basis),
    actualNetAmount,
    remainingOrderedQuantity: orderedRemaining.toString(),
    remainingReceivedQuantity: receivedRemaining.toString(),
    poDescription: input.poLine.description,
    poUnitPrice: input.poLine.unit_price,
    orderedQuantity: input.poLine.ordered_quantity,
    receivedQuantity: input.poLine.received_quantity,
    previouslyInvoicedQuantity: (
      input.used.get(input.poLine.id) ?? new Decimal(0)
    ).toString(),
    availableOrderedQuantity,
    availableReceivedQuantity,
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
  const receiptFailure = allocations.find((row) =>
    new Decimal(row.remainingReceivedQuantity).lt(0),
  );
  const receiptPasses = !receiptFailure;
  const requested = receiptFailure
    ? new Decimal(receiptFailure.quantity)
    : null;
  const receivedAvailability = receiptFailure
    ? new Decimal(receiptFailure.availableReceivedQuantity ?? 0)
    : null;
  const orderedAvailability = receiptFailure
    ? new Decimal(receiptFailure.availableOrderedQuantity ?? 0)
    : null;
  const shortfall = requested
    ? Decimal.max(requested.minus(receivedAvailability!), 0)
    : null;
  checks.push({
    code: "RECEIPT_CAPACITY",
    passed: receiptPasses,
    detail: receiptFailure
      ? `Requested ${requested} ${receiptFailure.uom ?? "units"}; received availability ${receivedAvailability} ${receiptFailure.uom ?? "units"}; shortfall ${shortfall} ${receiptFailure.uom ?? "units"}; ordered capacity ${orderedAvailability!.gte(requested!) ? "remains sufficient" : "is also insufficient"}.`
      : "Allocated quantities fit remaining receipts.",
    category: "CAPACITY",
    expected: receiptFailure
      ? `${receivedAvailability} ${receiptFailure.uom ?? "units"} received available for ${receiptFailure.sku}`
      : null,
    actual: receiptFailure
      ? `${requested} ${receiptFailure.uom ?? "units"} requested for ${receiptFailure.sku}`
      : null,
    sourceIds: receiptFailure?.sourceIds ?? [],
    ...(receiptFailure
      ? {
          calculation: {
            kind: "RECEIPT_CAPACITY" as const,
            sku: receiptFailure.sku,
            uom: receiptFailure.uom ?? "",
            requestedQuantity: requested!.toString(),
            receivedAvailability: receivedAvailability!.toString(),
            orderedAvailability: orderedAvailability!.toString(),
            shortfall: shortfall!.toString(),
          },
        }
      : {}),
  });
  const orderFailure = allocations.find((row) =>
    new Decimal(row.remainingOrderedQuantity).lt(0),
  );
  const orderPasses = !orderFailure;
  checks.push({
    code: "ORDERED_CAPACITY",
    passed: orderPasses,
    detail: "Allocated quantities fit remaining ordered capacity.",
    category: "CAPACITY",
    expected: orderFailure
      ? `${new Decimal(orderFailure.remainingOrderedQuantity).plus(orderFailure.quantity).toString()} ordered units available for ${orderFailure.sku}`
      : null,
    actual: orderFailure
      ? `${orderFailure.quantity} invoice units requested for ${orderFailure.sku}`
      : null,
    sourceIds: orderFailure?.sourceIds ?? [],
  });
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
    category: "CAPACITY",
    expected: `At most $${money(total.minus(priorBasis))} remaining PO value`,
    actual: `$${money(currentBasis)} invoice PO-basis value`,
    sourceIds: current.flatMap((row) => row.sourceIds ?? []),
  });
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
