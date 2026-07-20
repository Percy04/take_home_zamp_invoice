import type { ControlResult, Run } from "./types";

export type ReviewIssueCategory = "INVOICE_DATA" | "PO_RESOLUTION" | "MATCHING" | "RECEIPT" | "DUPLICATE" | "BUNDLE";

export type ReviewIssue = {
  category: ReviewIssueCategory;
  title: string;
  field?: string;
  condition?: string;
  value?: string;
  action?: string;
  confidence?: number | null;
  source?: string;
};

export function reviewRoute(run: Run) {
  return isExtractionIssue(run) ? "Document extraction issue" : "Business decision required";
}

export function isExtractionIssue(run: Run) {
  return (
    run.aiRechecks?.some((recheck) => recheck.outcome === "needs_review") ||
    ["LOW_CONFIDENCE", "EXTRACTION_FAILED", "MAPPING_FAILED", "MISSING_FIELD", "AMBIGUOUS_DATE"].includes(run.reasonCode ?? "")
  );
}

const categoryLabel: Record<ReviewIssueCategory, string> = {
  INVOICE_DATA: "Invoice data issues",
  PO_RESOLUTION: "Purchase order resolution",
  MATCHING: "Matching issues",
  RECEIPT: "Receipt quantity mismatch",
  DUPLICATE: "Duplicate invoice",
  BUNDLE: "Bundle decomposition",
};

const fieldLabel = (field: string) => {
  if (field === "invoiceDate") return "Invoice date";
  if (field === "poNumber") return "PO number";
  const lineQuantity = field.match(/^lines\.(\d+)\.quantity$/);
  if (lineQuantity) return `Line ${Number(lineQuantity[1]) + 1} quantity`;
  return field
    .replaceAll(".", " ")
    .replace(/([A-Z])/g, " $1")
    .trim();
};

const add = (issues: ReviewIssue[], issue: ReviewIssue) => {
  if (!issues.some((item) => item.category === issue.category && item.title === issue.title)) issues.push(issue);
};

function issueForCheck(run: Run, check: ControlResult): ReviewIssue {
  const evidence = run.evidence?.find((item) => check.sourceRefs?.includes(item.id)) ?? lowConfidenceEvidence(run, check.explanation);
  if (check.code === "MISSING_PO") return { category: "PO_RESOLUTION", title: "Select the purchase order" };
  if (check.calculation?.kind === "RECEIPT_CAPACITY" || check.category === "CAPACITY")
    return { category: "RECEIPT", title: "Quantity exceeds received goods" };
  if (check.calculation?.kind === "PRICE_VARIANCE" || check.category === "PRICE")
    return { category: "MATCHING", title: "Price differs from PO" };
  if (check.category === "DUPLICATE") return { category: "DUPLICATE", title: "Possible duplicate invoice" };
  if (check.code === "TOTAL_MISMATCH")
    return {
      category: "INVOICE_DATA",
      title: "Invoice lines do not match the total",
      action: check.explanation,
    };
  if (check.code === "LOW_CONFIDENCE") {
    const field = check.explanation.replace(/ could not be read reliably\.$/, "") || "Invoice fields";
    return {
      category: "INVOICE_DATA",
      title: "Document extraction issue",
      field,
      condition: "Low confidence",
      value: evidence?.content ?? check.explanation,
      action: "Review the extracted values.",
      confidence: evidence?.confidence,
      source: evidence ? `${evidence.label}${evidence.page ? ` · page ${evidence.page}` : ""}` : undefined,
    };
  }
  if (check.category === "IDENTITY")
    return {
      category: "INVOICE_DATA",
      title: check.name,
      field: "Invoice fields",
      condition: check.name,
      value: check.explanation,
      action: "Review the extracted values.",
    };
  return { category: "MATCHING", title: check.name };
}

function lowConfidenceEvidence(run: Run, explanation: string) {
  if (!/quantity/i.test(explanation)) return undefined;
  const values = run.invoice?.lines.flatMap((line) => [String(line.quantity), `${line.quantity} ${line.uom}`.trim()]);
  return run.evidence?.find((item) => values?.includes(item.content.trim()));
}

export function reviewIssues(run: Run): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const invoice = run.invoice;

  if (run.reasonCode === "MISSING_PO") return [{ category: "PO_RESOLUTION", title: "Select the purchase order" }];
  if (run.reasonCode === "UNKNOWN_BUNDLE") return [{ category: "BUNDLE", title: "Invoice item needs a component mapping" }];

  if (run.reasonCode === "AMBIGUOUS_DATE")
    add(issues, {
      category: "INVOICE_DATA",
      title: "Invoice date needs confirmation",
      field: "Invoice date",
      condition: "Ambiguous",
      value: invoice?.invoiceDate || "Not found",
      action: "Confirm the intended date.",
    });

  if (run.reasonCode === "MISSING_FIELD") {
    const missingFields = invoice?.missingFields?.length ? invoice.missingFields : !invoice?.invoiceDate ? ["invoiceDate"] : [];
    for (const field of missingFields) {
      const hasValue = field === "invoiceDate" ? Boolean(invoice?.invoiceDate) : field === "poNumber" ? Boolean(invoice?.poNumber) : false;
      if (!hasValue)
        add(issues, {
          category: "INVOICE_DATA",
          title: `${fieldLabel(field)} missing`,
          field: fieldLabel(field),
          condition: "Missing",
          value: "Not found",
          action: `Provide ${fieldLabel(field).toLowerCase()}.`,
        });
    }
  }

  for (const check of reviewChecks(run)) add(issues, issueForCheck(run, check));

  const fallback: Partial<Record<NonNullable<Run["reasonCode"]>, ReviewIssue>> = {
    DUPLICATE_INVOICE: { category: "DUPLICATE", title: "Possible duplicate invoice" },
    MISSING_FIELD: { category: "INVOICE_DATA", title: "Required invoice field missing" },
    MISSING_PO: { category: "PO_RESOLUTION", title: "Select the purchase order" },
    RECEIPT_CAPACITY_EXCEEDED: { category: "RECEIPT", title: "Quantity exceeds received goods" },
    PRICE_VARIANCE_EXCEEDED: { category: "MATCHING", title: "Price differs from PO" },
    UNKNOWN_BUNDLE: { category: "BUNDLE", title: "Invoice item needs a component mapping" },
    MULTIPLE_ISSUES: { category: "MATCHING", title: "Multiple issues require review" },
    TOTAL_MISMATCH: { category: "INVOICE_DATA", title: "Invoice lines do not match the total" },
    LOW_CONFIDENCE: { category: "INVOICE_DATA", title: "Document extraction issue" },
    EXTRACTION_FAILED: { category: "INVOICE_DATA", title: "Document could not be read" },
    MAPPING_FAILED: { category: "INVOICE_DATA", title: "Invoice details could not be linked" },
  };
  const fallbackIssue = run.reasonCode ? fallback[run.reasonCode] : undefined;
  if (fallbackIssue && !issues.length) add(issues, fallbackIssue as ReviewIssue);

  return issues;
}

export function reviewChecks(run: Run) {
  const failures = run.checks.filter((check) => !check.pass && !check.skipped);
  const hasDetailedPriceFailure = failures.some((check) => check.code === "PRICE_MATCH" && check.calculation?.kind === "PRICE_VARIANCE");
  return failures.filter(
    (check) =>
      !(
        hasDetailedPriceFailure &&
        check.code === "PRICE_MATCH" &&
        check.explanation === "Aggregate direct-line price variance is at most $5.00."
      ),
  );
}

export function reviewSummary(run: Run) {
  const issues = reviewIssues(run);
  const categories = [...new Set(issues.map((issue) => issue.category))];
  if (!issues.length) return null;
  const reasonWhy: Partial<Record<NonNullable<Run["reasonCode"]>, string>> = {
    MISSING_PO: "The invoice does not identify a purchase order, so a reviewer must choose the matching PO.",
    UNKNOWN_BUNDLE: "The invoice item is not a direct PO line; its quantity and value align with the listed PO components.",
    DUPLICATE_INVOICE: "This invoice matches a previously posted ledger entry and cannot be posted again.",
    PRICE_VARIANCE_EXCEEDED: "The invoice price differs from the purchase order beyond the allowed tolerance.",
    RECEIPT_CAPACITY_EXCEEDED: "The invoice quantity is greater than the goods received and available to invoice.",
    MULTIPLE_ISSUES: "More than one independent control requires a reviewer decision.",
    TOTAL_MISMATCH: "The extracted current-invoice lines do not reconcile to the printed invoice total.",
  };
  const explanation = run.reasonCode ? reasonWhy[run.reasonCode] : undefined;
  if (categories.length === 1) {
    return {
      issues,
      title: issues.length === 1 ? issues[0].title : `${categoryLabel[categories[0]]} · ${issues.length}`,
      explanation:
        explanation ??
        issues
          .map((issue) =>
            issue.title
              .replace("Invoice date needs confirmation", "Date needs confirmation")
              .replace("Select the purchase order", "A purchase order must be selected")
              .replace("PO number missing", "PO number is missing"),
          )
          .join(" and ") + ".",
    };
  }
  return {
    issues,
    title: `${issues.length} issues require review`,
    explanation: explanation ?? `${categories.map((category) => categoryLabel[category].toLowerCase()).join(" and ")} need attention.`,
  };
}

export { categoryLabel };
