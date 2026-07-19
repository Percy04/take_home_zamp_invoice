import { Decimal } from "decimal.js";
import { normalizedInvoiceSchema, type InvoicePreview, type NormalizedInvoice, type SourceRef } from "../../shared/contracts.js";
import { mappedEvidenceFields, type InvoiceMapping } from "./invoice-mapping.js";

const unsupportedCharge = /FREIGHT|SHIPPING|DISCOUNT|CREDIT|RETAINAGE|SPECIAL\s*CHARGE/i;
const unsupportedTax = /COMPOUND|EXEMPT|WITHHOLDING|REVERSE[\s-]?CHARGE|RECOVERAB/i;

export function buildInvoicePreview(evidence: SourceRef[], mapping: InvoiceMapping, missingField: string | null = null): InvoicePreview {
  const byId = new Map(evidence.map((source) => [source.id, source.content.trim()]));
  const read = (id: string | null | undefined) => (id ? (byId.get(id) ?? null) : null);
  return {
    vendor: read(mapping.vendor),
    invoiceNumber: read(mapping.invoiceNumber),
    invoiceDate: read(mapping.invoiceDate),
    poNumber: read(mapping.poNumber),
    currency: read(mapping.currency) ?? (evidence.some((source) => /\$/.test(source.content)) ? "USD" : null),
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

export function normalizeInvoice(evidence: SourceRef[], mapping: InvoiceMapping): NormalizedInvoice {
  const byId = new Map(evidence.map((source) => [source.id, source]));
  const lowConfidenceFields = mappedLowConfidenceFields(byId, mapping);
  if (lowConfidenceFields.length > 1) {
    throw new NormalizationError("MULTIPLE_ISSUES", undefined, lowConfidenceFields);
  }
  const selected: SourceRef[] = [];
  const fieldSources: Record<string, string> = {};
  const select = (id: string | null | undefined, required = false, field?: string, sources = fieldSources) => {
    if (!id) {
      if (required) failNormalization("MISSING_REQUIRED_FIELD", field);
      return "";
    }
    const source = byId.get(id);
    if (!source) failNormalization("MAPPING_FAILED");
    selected.push(source);
    if (field) sources[field] = id;
    if (source.confidence !== null && source.confidence < 0.75) failNormalization("LOW_CONFIDENCE", field);
    const value = source.content.normalize("NFKC").trim();
    if (required && !value) failNormalization("MISSING_REQUIRED_FIELD", field);
    return value;
  };

  for (const source of evidence) {
    if (!unsupportedCharge.test(source.label)) continue;
    const value = parseMoney(source.content, true);
    if (value && !value.isZero()) failNormalization("UNSUPPORTED_STRUCTURE");
  }
  if (evidence.some((source) => /CREDIT\s*(?:NOTE|MEMO)|REVERSE[\s-]?CHARGE|COMPOUND\s+TAX/i.test(`${source.label} ${source.content}`)))
    failNormalization("UNSUPPORTED_STRUCTURE");

  const vendor = select(mapping.vendor, true, "vendor");
  const invoiceNumber = select(mapping.invoiceNumber, true, "invoiceNumber");
  const invoiceDate = parseDate(select(mapping.invoiceDate, true, "invoiceDate"), "invoiceDate", evidence);
  const poNumber = select(mapping.poNumber, false, "poNumber");
  if (poNumber && poNumber.split(/[,;/\n]|\s+AND\s+/i).filter(Boolean).length > 1) failNormalization("UNSUPPORTED_STRUCTURE");
  if (!mapping.lines.length) failNormalization("MISSING_REQUIRED_FIELD", "lines");

  const observedLines = mapping.lines.map((line, index) => {
    const sourceIds: Record<string, string> = {};
    const rawSku = select(line.sku, false, "sku", sourceIds);
    const rawDescription = select(line.description, false, "description", sourceIds);
    const compact = compactLine(rawSku, rawDescription);
    const sku = compact?.sku ?? rawSku;
    const description = compact?.description ?? rawDescription;
    if (!sku && !description) failNormalization("MISSING_REQUIRED_FIELD", `lines.${index}.identity`);
    const mappedQuantity = select(line.quantity, false, "quantity", sourceIds);
    const quantityReading = compact?.quantity ?? mappedQuantity;
    const embeddedUom = quantityReading.match(/^[\d.,]+\s*([a-zA-Z]+)$/)?.[1] ?? "";
    let quantity = quantityReading ? parseQuantity(quantityReading.replace(/\s*[a-zA-Z]+$/, ""), `lines.${index}.quantity`) : null;
    const mappedUom = select(line.uom, false, "uom", sourceIds);
    const uom = parseUom(compact?.uom || mappedUom || embeddedUom || "");
    const mappedUnitPrice = select(line.unitPrice, false, "observedUnitPrice", sourceIds);
    let observedUnitPrice = optionalMoney(compact?.unitPrice ?? mappedUnitPrice, `lines.${index}.observedUnitPrice`);
    const mappedAmount = select(line.amount, false, "observedAmount", sourceIds);
    let observedAmount = optionalMoney(compact?.amount ?? mappedAmount, `lines.${index}.observedAmount`);
    const derivations: NormalizedInvoice["lines"][number]["derivations"] = [];
    if (!quantity && observedUnitPrice && observedAmount) {
      if (observedUnitPrice.isZero()) failNormalization("MISSING_REQUIRED_FIELD", `lines.${index}.quantity`);
      quantity = observedAmount.div(observedUnitPrice);
      derivations.push({
        field: "quantity",
        formula: `${money(observedAmount)} / ${money(observedUnitPrice)}`,
        sourceIds: [sourceIds.observedAmount, sourceIds.observedUnitPrice].filter((id): id is string => Boolean(id)),
      });
    }
    if (!observedUnitPrice && quantity && observedAmount) {
      observedUnitPrice = observedAmount.div(quantity);
      derivations.push({
        field: "unitPrice",
        formula: `${money(observedAmount)} / ${quantity.toString()}`,
        sourceIds: [sourceIds.observedAmount, sourceIds.quantity].filter((id): id is string => Boolean(id)),
      });
    }
    if (!observedAmount && quantity && observedUnitPrice) {
      observedAmount = quantity.mul(observedUnitPrice);
      derivations.push({
        field: "amount",
        formula: `${quantity.toString()} * ${money(observedUnitPrice)}`,
        sourceIds: [sourceIds.quantity, sourceIds.observedUnitPrice].filter((id): id is string => Boolean(id)),
      });
    }
    if (!quantity) failNormalization("MISSING_REQUIRED_FIELD", `lines.${index}.quantity`);
    if (!observedUnitPrice) failNormalization("MISSING_REQUIRED_FIELD", `lines.${index}.observedUnitPrice`);
    if (!observedAmount) failNormalization("MISSING_REQUIRED_FIELD", `lines.${index}.observedAmount`);
    const taxInclusion = select(line.taxInclusion, false, "taxInclusion", sourceIds);
    const taxRate = select(line.taxRate, false, "taxRate", sourceIds);
    const observedTaxAmount = optionalMoney(
      select(line.taxAmount, false, "observedTaxAmount", sourceIds),
      `lines.${index}.observedTaxAmount`,
    );
    if (quantity.mul(observedUnitPrice).minus(observedAmount).abs().gt("0.01")) failNormalization("TOTAL_MISMATCH");
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
      derivations,
    };
  });

  const observedSubtotal = optionalMoney(select(mapping.subtotal, false, "observedSubtotal"), "observedSubtotal");
  const observedTax = optionalMoney(select(mapping.tax, false, "observedTax"), "observedTax");
  const observedTotal = requiredMoney(select(mapping.total, true, "observedTotal"), "observedTotal");
  const taxNote = select(mapping.taxNote, false, "taxNote");
  if (unsupportedTax.test(taxNote)) failNormalization("UNSUPPORTED_STRUCTURE");

  const explicitCurrency = select(mapping.currency, false, "currency");
  const moneyText = selected
    .filter((source) => /AMOUNT|PRICE|TOTAL|TAX|SUBTOTAL/i.test(source.label))
    .map((source) => source.content)
    .join(" ");
  const currency = explicitCurrency
    ? parseCurrency(explicitCurrency)
    : /\$|\b(?:USD|US\s+DOLLARS?)\b/i.test(moneyText) && !/[€£¥]|\b(?:EUR|GBP|JPY|CAD|AUD)\b/i.test(moneyText)
      ? "USD"
      : "";
  if (!currency && /[€£¥]|\b(?:EUR|GBP|JPY|CAD|AUD)\b/i.test(moneyText)) failNormalization("UNSUPPORTED_STRUCTURE");
  if (!currency) failNormalization("MISSING_REQUIRED_FIELD", "currency");

  const documentInclusionClaim = claimsTaxInclusion(taxNote);
  const documentRate = parseTaxRate(taxNote);
  if (documentInclusionClaim && !documentRate) failNormalization("TAX_TREATMENT_UNRESOLVED");

  const lines = observedLines.map((line) => {
    const lineTaxText = `${line.taxInclusion} ${line.taxRate}`.trim();
    const hasLineTaxEvidence = Boolean(line.taxInclusion || line.taxRate);
    const inclusionClaim = hasLineTaxEvidence ? claimsTaxInclusion(lineTaxText) : documentInclusionClaim;
    const rate = hasLineTaxEvidence ? parseTaxRate(lineTaxText) : documentRate;
    if (inclusionClaim && !rate) failNormalization("TAX_TREATMENT_UNRESOLVED");
    const amount = inclusionClaim ? money(line.observedAmount.div(new Decimal(1).plus(rate!))) : money(line.observedAmount);
    const unitPrice = inclusionClaim ? money(new Decimal(amount).div(line.quantity)) : money(line.observedUnitPrice);
    const taxAmount = inclusionClaim ? money(line.observedAmount.minus(amount)) : money(line.observedTaxAmount ?? 0);
    return {
      sku: line.sku,
      description: line.description,
      quantity: line.quantity.toString(),
      uom: line.uom,
      observedUnitPrice: money(line.observedUnitPrice),
      observedAmount: money(line.observedAmount),
      observedTaxAmount: line.observedTaxAmount ? money(line.observedTaxAmount) : null,
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
      derivations: [
        ...line.derivations,
        ...(inclusionClaim
          ? [
              {
                field: "amount",
                formula: `${money(line.observedAmount)} / (1 + ${rate!.toString()})`,
                sourceIds: [line.sourceIds.observedAmount, fieldSources.taxNote].filter((id): id is string => Boolean(id)),
              },
            ]
          : []),
      ],
    };
  });
  const goodsSubtotal = lines.reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
  if (observedSubtotal && observedSubtotal.minus(goodsSubtotal).abs().gt("0.01")) failNormalization("TOTAL_MISMATCH");

  let taxTreatment: NormalizedInvoice["taxTreatment"];
  let normalizedTax: Decimal;
  const inclusiveLines = lines.filter((line) => line.taxTreatment === "INCLUSIVE");
  const hasInclusiveLines = inclusiveLines.length > 0;
  const hasNonInclusiveLines = inclusiveLines.length < lines.length;
  if (hasInclusiveLines && hasNonInclusiveLines) {
    if (lines.some((line) => line.taxTreatment !== "INCLUSIVE" && !line.sourceIds.observedTaxAmount))
      failNormalization("TAX_TREATMENT_UNRESOLVED");
    taxTreatment = "MIXED";
    normalizedTax = lines.reduce((sum, line) => sum.plus(line.taxAmount), new Decimal(0));
  } else if (hasInclusiveLines) {
    taxTreatment = "INCLUSIVE";
    normalizedTax = lines.reduce((sum, line) => sum.plus(line.taxAmount), new Decimal(0));
    if (observedTax && observedTax.minus(normalizedTax).abs().gt("0.01")) failNormalization("TOTAL_MISMATCH");
  } else if (observedTax) {
    taxTreatment = observedTax.isZero() ? "ZERO" : "EXCLUSIVE";
    normalizedTax = observedTax;
  } else if (goodsSubtotal.minus(observedTotal).abs().lte("0.01")) {
    taxTreatment = "ZERO";
    normalizedTax = new Decimal(0);
  } else {
    failNormalization("TOTAL_MISMATCH");
  }

  if (goodsSubtotal.plus(normalizedTax).minus(observedTotal).abs().gt("0.01")) failNormalization("TOTAL_MISMATCH");

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
    taxRate: taxTreatment === "INCLUSIVE" && new Set(lines.map((line) => line.taxRate)).size === 1 ? lines[0]!.taxRate : null,
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
            sourceIds: [fieldSources.observedTotal, fieldSources.taxNote].filter((id): id is string => Boolean(id)),
          },
        ]
      : [],
  });
}

export class NormalizationError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly field?: string,
    readonly fields: string[] = field ? [field] : [],
  ) {
    super(field ? `${reasonCode}: ${field}` : reasonCode);
  }
}

function mappedLowConfidenceFields(evidence: Map<string, SourceRef>, mapping: InvoiceMapping) {
  return mappedEvidenceFields(mapping).flatMap(({ field, id }) => {
    const confidence = id ? evidence.get(id)?.confidence : null;
    return confidence !== null && confidence !== undefined && confidence < 0.75 ? [normalizationField(field)] : [];
  });
}

function normalizationField(field: string) {
  return (
    {
      subtotal: "observedSubtotal",
      tax: "observedTax",
      total: "observedTotal",
    }[field] ?? field
  );
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
  const negative = /^\(.*\)$/.test(normalized) || /^-/.test(normalized) || /-$/.test(normalized);
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

function parseUom(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (["EA", "EACH", "PC", "PCS"].includes(normalized)) return "EA";
  if (normalized === "KIT") return "KIT";
  if (!normalized) return "";
  return normalized;
}

function compactLine(...values: string[]) {
  const value = values.find((candidate) => candidate.includes("|"));
  if (!value) return null;
  const parts = value
    .replace(/^\s*Line\s+\d+\s*:\s*/i, "")
    .split("|")
    .map((part) => part.trim());
  if (parts.length < 2) return null;
  const uom = parts
    .slice(2)
    .join(" ")
    .match(/\b(EA|EACH|PC|PCS|KIT|HRS?|HOURS?)\b/i)?.[1];
  const arithmetic = parts
    .slice(2)
    .join(" ")
    .match(/(-?\d+(?:[.,]\d+)?)\s*(?:EA|EACH|PC|PCS|KIT|HRS?|HOURS?)?\s*[x×]\s*\$?([\d,.]+)\s*=\s*\$?([\d,.]+)/i);
  return {
    sku: parts[0]!,
    description: parts[1]!,
    uom: uom ?? "",
    quantity: arithmetic?.[1],
    unitPrice: arithmetic?.[2],
    amount: arithmetic?.[3],
  };
}

function parseDate(value: string, field?: string, evidence: SourceRef[] = []) {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  let year: number;
  let month: number;
  let day: number;
  let match = normalized.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (match) [, year, month, day] = match.map(Number);
  else if ((match = normalized.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/))) {
    const [, first, second, parsedYear] = match.map(Number);
    year = parsedYear!;
    if (first! > 12 && second! <= 12) [day, month] = [first!, second!];
    else if (second! > 12 && first! <= 12) [month, day] = [first!, second!];
    else if (first === second) [month, day] = [first!, second!];
    else {
      const order = numericDateOrder(evidence);
      if (order === "MONTH_FIRST") [month, day] = [first!, second!];
      else if (order === "DAY_FIRST") [day, month] = [first!, second!];
      else failNormalization("AMBIGUOUS_DATE", field);
    }
  } else {
    const dayFirst = normalized.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s.-]+([A-Za-z]{3,9})[\s,.-]+(\d{4})$/i);
    const monthFirst = normalized.match(/^([A-Za-z]{3,9})[\s.-]+(\d{1,2})(?:st|nd|rd|th)?[,]?[\s.-]+(\d{4})$/i);
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
  if (date.getUTCFullYear() !== year! || date.getUTCMonth() + 1 !== month! || date.getUTCDate() !== day!)
    failNormalization("MISSING_REQUIRED_FIELD", field);
  return `${String(year!).padStart(4, "0")}-${String(month!).padStart(2, "0")}-${String(day!).padStart(2, "0")}`;
}

function numericDateOrder(evidence: SourceRef[]) {
  const orders = new Set<"MONTH_FIRST" | "DAY_FIRST">();
  for (const source of evidence) {
    if (!/DUE[\s_-]*DATE/i.test(source.label)) continue;
    const match = source.content.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-]\d{4}$/);
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (second > 12 && first <= 12) orders.add("MONTH_FIRST");
    if (first > 12 && second <= 12) orders.add("DAY_FIRST");
  }
  return orders.size === 1 ? [...orders][0] : null;
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
  return fraction.length === 3 ? parts.join("") : `${parts.slice(0, -1).join("")}.${fraction}`;
}

function parseCurrency(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z$]/g, "");
  if (["USD", "US$", "$", "USDOLLAR", "USDOLLARS"].includes(normalized)) return "USD";
  failNormalization("UNSUPPORTED_STRUCTURE");
}

function monthNumber(value: string) {
  const names = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
  const normalized = value.toUpperCase();
  const month = names.findIndex((name) => name === normalized || name.slice(0, 3) === normalized);
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
  return /(?:INCLUD(?:E|ES|ED|ING)|INCL\.?).*?(?:TAX|VAT|GST)|(?:TAX|VAT|GST).*?(?:INCLUD|INCL\.?)/i.test(value);
}

function money(value: Decimal.Value) {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function failNormalization(reasonCode: string, field?: string): never {
  throw new NormalizationError(reasonCode, field);
}
