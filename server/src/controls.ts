import { Decimal } from "decimal.js";
import {
  normalizedInvoiceSchema,
  type Allocation,
  type BundleCandidate,
  type CheckResult,
  type InvoicePreview,
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

export function buildInvoicePreview(
  evidence: SourceRef[],
  mapping: InvoiceMapping,
  missingField: string | null = null,
): InvoicePreview {
  const byId = new Map(
    evidence.map((source) => [source.id, source.content.trim()]),
  );
  const read = (id: string | null | undefined) =>
    id ? (byId.get(id) ?? null) : null;
  return {
    vendor: read(mapping.vendor),
    invoiceNumber: read(mapping.invoiceNumber),
    invoiceDate: read(mapping.invoiceDate),
    poNumber: read(mapping.poNumber),
    currency:
      read(mapping.currency) ??
      (evidence.some((source) => /\$/.test(source.content)) ? "USD" : null),
    subtotal: read(mapping.subtotal),
    tax: read(mapping.tax),
    total: read(mapping.total),
    missingField,
    lines: mapping.lines.map((line) => ({
      sku: read(line.sku),
      description: read(line.description),
      quantity: read(line.quantity),
      uom: read(line.uom),
      unitPrice: read(line.unitPrice),
      amount: read(line.amount),
    })),
  };
}

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
      if (required) failNormalization("MISSING_REQUIRED_FIELD", field);
      return "";
    }
    const source = byId.get(id);
    if (!source) failNormalization("MAPPING_FAILED");
    selected.push(source);
    if (field) sources[field] = id;
    if (source.confidence !== null && source.confidence < 0.75)
      failNormalization("LOW_CONFIDENCE", field);
    const value = source.content.normalize("NFKC").trim();
    if (required && !value) failNormalization("MISSING_REQUIRED_FIELD", field);
    return value;
  };

  for (const source of evidence) {
    if (!unsupportedCharge.test(source.label)) continue;
    const value = parseMoney(source.content, true);
    if (value && !value.isZero()) failNormalization("UNSUPPORTED_STRUCTURE");
  }
  if (
    evidence.some((source) =>
      /CREDIT\s*(?:NOTE|MEMO)|REVERSE[\s-]?CHARGE|COMPOUND\s+TAX/i.test(
        `${source.label} ${source.content}`,
      ),
    )
  )
    failNormalization("UNSUPPORTED_STRUCTURE");

  const vendor = select(mapping.vendor, true, "vendor");
  const invoiceNumber = select(mapping.invoiceNumber, true, "invoiceNumber");
  const invoiceDate = parseDate(
    select(mapping.invoiceDate, true, "invoiceDate"),
    "invoiceDate",
  );
  const poNumber = select(mapping.poNumber, false, "poNumber");
  if (
    poNumber &&
    poNumber.split(/[,;/\n]|\s+AND\s+/i).filter(Boolean).length > 1
  )
    failNormalization("UNSUPPORTED_STRUCTURE");
  if (!mapping.lines.length)
    failNormalization("MISSING_REQUIRED_FIELD", "lines");

  const observedLines = mapping.lines.map((line, index) => {
    const sourceIds: Record<string, string> = {};
    const sku = select(line.sku, false, "sku", sourceIds);
    const description = select(
      line.description,
      false,
      "description",
      sourceIds,
    );
    if (!sku && !description)
      failNormalization("MISSING_REQUIRED_FIELD", `lines.${index}.identity`);
    const quantity = parseQuantity(
      select(line.quantity, true, "quantity", sourceIds),
      `lines.${index}.quantity`,
    );
    const uom = parseUom(
      select(line.uom, true, "uom", sourceIds),
      `lines.${index}.uom`,
    );
    const observedUnitPrice = requiredMoney(
      select(line.unitPrice, true, "observedUnitPrice", sourceIds),
      `lines.${index}.observedUnitPrice`,
    );
    const observedAmount = requiredMoney(
      select(line.amount, true, "observedAmount", sourceIds),
      `lines.${index}.observedAmount`,
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
      `lines.${index}.observedTaxAmount`,
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
    "observedSubtotal",
  );
  const observedTax = optionalMoney(
    select(mapping.tax, false, "observedTax"),
    "observedTax",
  );
  const observedTotal = requiredMoney(
    select(mapping.total, true, "observedTotal"),
    "observedTotal",
  );
  const taxNote = select(mapping.taxNote, false, "taxNote");
  if (unsupportedTax.test(taxNote)) failNormalization("UNSUPPORTED_STRUCTURE");

  const explicitCurrency = select(mapping.currency, false, "currency");
  const moneyText = selected
    .filter((source) => /AMOUNT|PRICE|TOTAL|TAX|SUBTOTAL/i.test(source.label))
    .map((source) => source.content)
    .join(" ");
  const currency = explicitCurrency
    ? parseCurrency(explicitCurrency)
    : /\$|\b(?:USD|US\s+DOLLARS?)\b/i.test(moneyText) &&
        !/[€£¥]|\b(?:EUR|GBP|JPY|CAD|AUD)\b/i.test(moneyText)
      ? "USD"
      : "";
  if (!currency && /[€£¥]|\b(?:EUR|GBP|JPY|CAD|AUD)\b/i.test(moneyText))
    failNormalization("UNSUPPORTED_STRUCTURE");
  if (!currency) failNormalization("MISSING_REQUIRED_FIELD", "currency");

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

  const vendorMatches = vendors.filter((row) => {
    const names = [
      row.canonical_name,
      ...(JSON.parse(row.aliases_json) as string[]),
    ];
    return names.some((name) => normalize(name) === normalize(invoice.vendor));
  });
  gate(
    "VENDOR_MATCH",
    vendorMatches.length === 1,
    "Vendor resolves to one active master record.",
  );
  const vendor = vendorMatches[0]!;
  gate(
    "DUPLICATE",
    !postedInvoices.some(
      (row) =>
        row.vendor_id === vendor.id &&
        row.normalized_invoice_number === normalize(invoice.invoiceNumber),
    ),
    "Invoice number has not already been posted for this vendor.",
    {
      category: "DUPLICATE",
      expected: "A new invoice number for this vendor",
      actual: invoice.invoiceNumber,
      sourceIds: [invoice.fieldSources.invoiceNumber].filter(Boolean),
    },
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
  constructor(
    readonly reasonCode: string,
    readonly field?: string,
  ) {
    super(field ? `${reasonCode}: ${field}` : reasonCode);
  }
}

export function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
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

function requiredMoney(value: string, field?: string) {
  const parsed = parseMoney(value, false, field);
  if (!parsed) failNormalization("MISSING_REQUIRED_FIELD", field);
  if (parsed.isNegative()) failNormalization("UNSUPPORTED_STRUCTURE");
  return parsed;
}

function optionalMoney(value: string, field?: string) {
  const parsed = value ? parseMoney(value, false, field) : null;
  if (parsed?.isNegative()) failNormalization("UNSUPPORTED_STRUCTURE");
  return parsed;
}

function parseMoney(value: string, allowUnparseable: boolean, field?: string) {
  let normalized = value.normalize("NFKC").replace(/\s/g, "").trim();
  if (!normalized) return null;
  const negative =
    /^\(.*\)$/.test(normalized) ||
    /^-/.test(normalized) ||
    /-$/.test(normalized);
  normalized = normalized
    .replace(/^\((.*)\)$/, "$1")
    .replace(/^-|-$|^(?:USD|US\$|\$)/i, "")
    .replace(/(?:USD|US\$|\$)$/i, "");
  if (/[€£¥]|\b(?:EUR|GBP|JPY|CAD|AUD)\b/i.test(normalized)) {
    if (allowUnparseable) return null;
    failNormalization("UNSUPPORTED_STRUCTURE");
  }
  const stripped = canonicalNumber(normalized);
  if (!stripped) {
    if (allowUnparseable) return null;
    failNormalization("MISSING_REQUIRED_FIELD", field);
  }
  const parsed = new Decimal(stripped);
  return negative ? parsed.negated() : parsed;
}

function parseQuantity(value: string, field?: string) {
  let normalized = value.normalize("NFKC").replace(/\s/g, "").trim();
  const negative = /^-/.test(normalized) || /-$/.test(normalized);
  normalized = normalized.replace(/^-|-$|^\((.*)\)$/, "$1");
  const stripped = canonicalNumber(normalized);
  if (!stripped) failNormalization("MISSING_REQUIRED_FIELD", field);
  const quantity = new Decimal(stripped);
  if (negative || quantity.lte(0)) failNormalization("UNSUPPORTED_STRUCTURE");
  return quantity;
}

function parseUom(value: string, field?: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (["EA", "EACH", "PC", "PCS"].includes(normalized)) return "EA";
  if (normalized === "KIT") return "KIT";
  if (!normalized) failNormalization("MISSING_REQUIRED_FIELD", field);
  return normalized;
}

function parseDate(value: string, field?: string) {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  let year: number;
  let month: number;
  let day: number;
  let match = normalized.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (match) [, year, month, day] = match.map(Number);
  else if (
    (match = normalized.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/))
  ) {
    const [, first, second, parsedYear] = match.map(Number);
    year = parsedYear!;
    if (first! > 12 && second! <= 12) [day, month] = [first!, second!];
    else if (second! > 12 && first! <= 12) [month, day] = [first!, second!];
    else if (first === second) [month, day] = [first!, second!];
    else failNormalization("AMBIGUOUS_DATE", field);
  } else {
    const dayFirst = normalized.match(
      /^(\d{1,2})(?:st|nd|rd|th)?[\s.-]+([A-Za-z]{3,9})[\s,.-]+(\d{4})$/i,
    );
    const monthFirst = normalized.match(
      /^([A-Za-z]{3,9})[\s.-]+(\d{1,2})(?:st|nd|rd|th)?[,]?[\s.-]+(\d{4})$/i,
    );
    if (dayFirst) {
      day = Number(dayFirst[1]);
      month = monthNumber(dayFirst[2]!);
      year = Number(dayFirst[3]);
    } else if (monthFirst) {
      month = monthNumber(monthFirst[1]!);
      day = Number(monthFirst[2]);
      year = Number(monthFirst[3]);
    } else failNormalization("MISSING_REQUIRED_FIELD", field);
  }
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    date.getUTCFullYear() !== year! ||
    date.getUTCMonth() + 1 !== month! ||
    date.getUTCDate() !== day!
  )
    failNormalization("MISSING_REQUIRED_FIELD", field);
  return `${String(year!).padStart(4, "0")}-${String(month!).padStart(2, "0")}-${String(day!).padStart(2, "0")}`;
}

function canonicalNumber(value: string) {
  if (!/^[\d.,]+$/.test(value)) return null;
  const commas = [...value.matchAll(/,/g)].map((match) => match.index!);
  const dots = [...value.matchAll(/\./g)].map((match) => match.index!);
  if (commas.length && dots.length) {
    const decimal = commas.at(-1)! > dots.at(-1)! ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    return value.replace(thousands, "").replace(decimal, ".");
  }
  const separator = commas.length ? "," : dots.length ? "." : null;
  if (!separator) return value;
  const parts = value.split(separator);
  if (parts.length === 2) {
    const fraction = parts[1]!;
    return fraction.length === 3 ? parts.join("") : parts.join(".");
  }
  const fraction = parts.at(-1)!;
  return fraction.length === 3
    ? parts.join("")
    : `${parts.slice(0, -1).join("")}.${fraction}`;
}

function parseCurrency(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z$]/g, "");
  if (["USD", "US$", "$", "USDOLLAR", "USDOLLARS"].includes(normalized))
    return "USD";
  failNormalization("UNSUPPORTED_STRUCTURE");
}

function monthNumber(value: string) {
  const names = [
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
  ];
  const normalized = value.toUpperCase();
  const month = names.findIndex(
    (name) => name === normalized || name.slice(0, 3) === normalized,
  );
  if (month < 0) failNormalization("MISSING_REQUIRED_FIELD", "invoiceDate");
  return month + 1;
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
  return /(?:INCLUD(?:E|ES|ED|ING)|INCL\.?).*?(?:TAX|VAT|GST)|(?:TAX|VAT|GST).*?(?:INCLUD|INCL\.?)/i.test(
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

function failNormalization(reasonCode: string, field?: string): never {
  throw new NormalizationError(reasonCode, field);
}
