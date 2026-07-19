import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { sourceRefSchema, type SourceRef } from "../../shared/contracts.js";
import { recheckLowConfidenceFields, type LowConfidenceField } from "../../server/src/ai-rechecks.js";
import { validateMapping, type InvoiceMapping } from "../../server/src/invoice-mapping.js";
import type { InvoiceExtractor } from "../../server/src/providers.js";

export const recordedInvoiceExtractor: InvoiceExtractor = async (bytes) => {
  const recording = await recordingForDocument(bytes);
  const evidence = await recordedEvidence(recording);
  const mapping: InvoiceMapping = {
    vendor: "case.vendor",
    invoiceNumber: "case.invoiceNumber",
    invoiceDate: "case.invoiceDate",
    poNumber: "case.poNumber",
    currency: "case.currency",
    subtotal: hasSource(evidence, "case.subtotal") ? "case.subtotal" : null,
    tax: hasSource(evidence, "case.tax") ? "case.tax" : null,
    total: "case.total",
    taxNote: hasSource(evidence, "case.taxNote") ? "case.taxNote" : null,
    lines: recordedLineIndexes(evidence).map((index) => ({
      sku: `case.lines.${index}.sku`,
      description: `case.lines.${index}.description`,
      quantity: `case.lines.${index}.quantity`,
      uom: `case.lines.${index}.uom`,
      unitPrice: `case.lines.${index}.unitPrice`,
      amount: `case.lines.${index}.amount`,
    })),
  };
  if (recording === "happy_layout_c_scanned") {
    mapping.poNumber = "field.PurchaseOrder";
    mapping.lines = mapping.lines.map((line, index) => ({ ...line, sku: `item.${index}.ProductCode`, quantity: `item.${index}.Quantity` }));
  }
  validateMapping(mapping, evidence);
  return recording === "happy_layout_c_scanned"
    ? recheckLowConfidenceFields(bytes, evidence, mapping, async (_page, fields) => recordedRecheckValues(fields), "recorded-fixture")
    : { evidence, mapping, originalMapping: mapping, aiRechecks: [] };
};

function recordedRecheckValues(fields: LowConfidenceField[]) {
  const values: Record<string, string> = {
    poNumber: "PO-1001",
    "lines.0.sku": "WID-100",
    "lines.0.quantity": "8",
    "lines.1.quantity": "5",
  };
  return Object.fromEntries(fields.map((field) => [field.field, values[field.field] ?? null]));
}

async function recordingForDocument(bytes: Buffer) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  const title = pdf.getTitle();
  const scannedFixture =
    title === "untitled" &&
    pdf.getAuthor() === "anonymous" &&
    pdf.getCreator() === "anonymous" &&
    pdf.getPage(0).node.Resources()?.toString().includes("/FormXob.59434872ae9880c0340555aef842a3a5");
  if (scannedFixture) return "happy_layout_c_scanned";
  if (title === "Invoice ACME-2026-001") return "happy";
  if (title === "Invoice ACME-2026-000") return "duplicate";
  if (title === "Invoice DELTA-2026-010") return "receipt_capacity";
  if (title === "Invoice DELTA-2026-011") return "multiple_issues";
  if (title === "Invoice ACME-2026-003") return "bundle_known";
  if (title === "Invoice ACME-2026-005") return "tax_inclusive";
  if (title === "Invoice ACME-2026-002") return "missing_po";
  if (title === "Invoice ACME-2026-006") return "missing_po_bundle";
  if (title === "Invoice ACME-2026-004") return "bundle_unknown";
  throw new Error("No recorded provider response for this document.");
}

async function recordedEvidence(recording: string) {
  const sourcesPath = path.resolve(`tests/fixtures/recordings/${recording}_sources.json`);
  let evidence: SourceRef[] = [];
  try {
    evidence = sourceRefSchema.array().parse(JSON.parse(await readFile(sourcesPath, "utf8")) as unknown);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw caught;
  }
  const cases = JSON.parse(await readFile(path.resolve("data/cases.json"), "utf8")) as {
    fixtures: Record<string, { input: RecordedInput }>;
  };
  const input = cases.fixtures[recording]?.input;
  if (!input) throw new Error("Unknown recorded fixture.");
  const caseRefs: SourceRef[] = [
    ref("case.vendor", "VendorName", input.vendor),
    ref("case.invoiceNumber", "InvoiceId", input.invoice_number),
    ref("case.invoiceDate", "InvoiceDate", input.invoice_date),
    ref("case.poNumber", "PurchaseOrder", input.po_number ?? ""),
    ref("case.currency", "Currency", input.currency),
    ref("case.total", "InvoiceTotal", input.total),
    ...(input.subtotal ? [ref("case.subtotal", "SubTotal", input.subtotal)] : []),
    ...(input.tax ? [ref("case.tax", "TotalTax", input.tax)] : []),
    ...(input.tax_note ? [ref("case.taxNote", "TaxNote", input.tax_note)] : []),
    ...input.lines.flatMap((line, index) => [
      ref(`case.lines.${index}.sku`, "ProductCode", line.sku),
      ref(`case.lines.${index}.description`, "Description", line.description),
      ref(`case.lines.${index}.quantity`, "Quantity", line.quantity),
      ref(`case.lines.${index}.uom`, "Unit", line.uom),
      ref(`case.lines.${index}.unitPrice`, "UnitPrice", line.unit_price),
      ref(`case.lines.${index}.amount`, "Amount", line.amount),
    ]),
  ];
  return sourceRefSchema.array().parse([...evidence, ...caseRefs]);
}

type RecordedInput = {
  vendor: string;
  invoice_number: string;
  invoice_date: string;
  po_number: string | null;
  currency: string;
  subtotal: string | null;
  tax: string | null;
  total: string;
  tax_note?: string;
  lines: Array<{ sku: string; description: string; quantity: string; uom: string; unit_price: string; amount: string }>;
};

function ref(id: string, label: string, content: string): SourceRef {
  return { id, label, content, confidence: 1, page: 1 };
}

function hasSource(evidence: SourceRef[], id: string) {
  return evidence.some((source) => source.id === id);
}

function recordedLineIndexes(evidence: SourceRef[]) {
  return [...new Set(evidence.map((source) => source.id.match(/^case\.lines\.(\d+)\./)?.[1]).filter(Boolean).map(Number))].sort(
    (left, right) => left - right,
  );
}
