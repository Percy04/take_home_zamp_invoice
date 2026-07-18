import type { CheckResult, RunDetail, RunSummary } from "../../../shared/contracts";
import type { ActivityEntry, ControlCategory, Invoice, ReasonCode, Run, Stage } from "./types";

const number = (value: string | null | undefined) => {
  const raw = value?.trim();
  if (!raw) return Number.NaN;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);

  const groupedUsd = raw.match(/^(?:USD\s*)?(-?)\$?((?:\d+|\d{1,3}(?:[ ,]\d{3})+))(\.\d+)?$/i);
  if (!groupedUsd) return Number.NaN;
  return Number(`${groupedUsd[1]}${groupedUsd[2].replace(/[ ,]/g, "")}${groupedUsd[3] ?? ""}`);
};
const quantity = (value: string | null | undefined) => {
  const match = value?.trim().match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
  return { value: number(match?.[1] ?? value), uom: match?.[2]?.trim() ?? "" };
};
const text = (value: string) =>
  value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

function reasonCode(value: string | null): ReasonCode | null {
  if (!value) return null;
  return (
    (
      {
        DUPLICATE: "DUPLICATE_INVOICE",
        MISSING_REQUIRED_FIELD: "MISSING_FIELD",
        PO_CAPACITY_EXCEEDED: "RECEIPT_CAPACITY_EXCEEDED",
        BUNDLE_MAPPING_REQUIRED: "UNKNOWN_BUNDLE",
      } as Record<string, ReasonCode>
    )[value] ?? (value as ReasonCode)
  );
}

function invoice(detail: RunDetail): Invoice | null {
  if (detail.invoice) {
    return {
      vendor: detail.invoice.vendor,
      invoiceNumber: detail.invoice.invoiceNumber,
      invoiceDate: detail.invoice.invoiceDate,
      poNumber: detail.invoice.poNumber || null,
      currency: detail.invoice.currency,
      observedSubtotal: number(detail.invoice.observedSubtotal),
      observedTax: number(detail.invoice.observedTax),
      observedTotal: number(detail.invoice.observedTotal),
      normalizedSubtotal: number(detail.invoice.subtotal),
      normalizedTax: number(detail.invoice.tax),
      normalizedTotal: number(detail.invoice.total),
      taxTreatment: detail.invoice.taxTreatment === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE",
      taxNote: detail.invoice.derivations.map((item) => item.formula).join(" · ") || undefined,
      lines: detail.invoice.lines.map((line) => {
        const parsedQuantity = quantity(line.quantity);
        return {
          sku: line.sku,
          description: line.description,
          quantity: parsedQuantity.value,
          uom: line.uom || parsedQuantity.uom,
          unitPrice: number(line.unitPrice),
          amount: number(line.amount),
          observedUnitPrice: number(line.observedUnitPrice),
          observedAmount: number(line.observedAmount),
        };
      }),
    };
  }
  if (!detail.invoicePreview) return null;
  const preview = detail.invoicePreview;
  return {
    vendor: preview.vendor ?? "Unknown vendor",
    invoiceNumber: preview.invoiceNumber ?? detail.filename,
    invoiceDate: preview.invoiceDate,
    poNumber: preview.poNumber,
    currency: preview.currency ?? "USD",
    observedSubtotal: number(preview.subtotal),
    observedTax: number(preview.tax),
    observedTotal: number(preview.total),
    normalizedSubtotal: number(preview.subtotal),
    normalizedTax: number(preview.tax),
    normalizedTotal: number(preview.total),
    taxTreatment: "EXCLUSIVE",
    missingFields: detail.reasonCode === "MISSING_REQUIRED_FIELD" && preview.missingField ? [preview.missingField] : undefined,
    lines: preview.lines.map((line) => {
      const parsedQuantity = quantity(line.quantity);
      return {
        sku: line.sku ?? "",
        description: line.description ?? "",
        quantity: parsedQuantity.value,
        uom: line.uom || parsedQuantity.uom,
        unitPrice: number(line.unitPrice),
        amount: number(line.amount),
      };
    }),
  };
}

function category(value: string | undefined): ControlCategory {
  return (
    (
      {
        IDENTITY: "IDENTITY",
        DUPLICATE: "DUPLICATE",
        PURCHASE_ORDER: "IDENTITY",
        MATCHING: "LINE_MATCH",
        AMOUNTS: "ARITHMETIC",
        CAPACITY: "CAPACITY",
      } as Record<string, ControlCategory>
    )[value ?? ""] ?? "ARITHMETIC"
  );
}

function calculation(check: CheckResult) {
  const value = check.calculation;
  if (!value) return undefined;
  if (value.kind === "RECEIPT_CAPACITY")
    return {
      kind: "RECEIPT_CAPACITY" as const,
      sku: value.sku,
      uom: value.uom,
      requestedQuantity: number(value.requestedQuantity),
      receivedAvailability: number(value.receivedAvailability),
      orderedAvailability: number(value.orderedAvailability),
      shortfall: number(value.shortfall),
    };
  return {
    kind: "PRICE_VARIANCE" as const,
    sku: value.sku,
    uom: value.uom,
    quantity: number(value.quantity),
    invoiceUnitPrice: number(value.invoiceUnitPrice),
    poUnitPrice: number(value.poUnitPrice),
    varianceAmount: number(value.varianceAmount),
    variancePercent: value.variancePercent,
    tolerancePercent: value.tolerancePercent,
  };
}

function activity(detail: RunDetail): ActivityEntry[] {
  const entries: ActivityEntry[] = detail.stages.map((event) => ({
    at: event.at,
    message: `${text(event.stage)} ${event.status === "ACTIVE" ? "started" : event.status.toLowerCase()}.`,
    kind: event.status === "FAILED" ? ("error" as const) : ("info" as const),
  }));
  if (detail.state === "POSTED") entries.push({ at: detail.updatedAt, message: "Approved and posted.", kind: "success" });
  if (detail.state === "NEEDS_REVIEW") entries.push({ at: detail.updatedAt, message: "Routed for review.", kind: "warn" });
  return entries;
}

export function toUiRun(detail: RunDetail): Run {
  const inv = invoice(detail);
  const failedChecks = detail.checks.filter((check) => !check.passed);
  return {
    runId: detail.runId,
    filename: detail.filename,
    state: detail.state,
    execution: detail.execution ?? "PENDING",
    reasonCode: reasonCode(detail.reasonCode),
    nextAction: detail.nextAction,
    ledgerId: detail.ledgerId,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    stages: detail.stages.map((event) => ({
      stage: event.stage as Stage,
      label: text(event.stage),
      status: event.status === "ACTIVE" ? "IN_PROGRESS" : event.status === "COMPLETED" ? "DONE" : "FAILED",
    })),
    invoice: inv,
    duplicateMatch: detail.duplicateMatch
      ? {
          ledgerId: detail.duplicateMatch.ledgerId,
          originalInvoiceNumber: detail.duplicateMatch.invoiceNumber,
          vendor: inv?.vendor ?? "Unknown vendor",
          invoiceDate: detail.duplicateMatch.invoiceDate,
          poNumber: detail.duplicateMatch.poNumber,
          total: number(detail.duplicateMatch.total),
          postedAt: detail.duplicateMatch.postedAt,
          originalLines: detail.duplicateMatch.allocations.map((line) => ({
            sku: line.sku,
            description: line.description,
            quantity: number(line.quantity),
            uom: line.uom,
            poBasisUnitPrice: number(line.unitPrice),
          })),
        }
      : undefined,
    poCandidates: detail.poCandidates.map((candidate) => ({
      poNumber: candidate.poNumber,
      vendor: inv?.vendor ?? "Unknown vendor",
      confidence: candidate.allLinesResolvable ? "HIGH" : candidate.matchedLineCount ? "MEDIUM" : "LOW",
      aggregateDifference: number(candidate.subtotalDifference),
      lines: candidate.lines.map((line) => {
        const quantity = number(line.requestedQuantity);
        const unitPrice = number(line.poUnitPrice);
        return {
          invoiceSku: line.invoiceSku,
          invoiceDescription: line.invoiceDescription,
          requestedQuantity: quantity,
          uom: line.uom,
          invoiceUnitPrice: unitPrice,
          invoiceAmount: unitPrice * quantity,
          poLineId: line.poLineId,
          poSku: line.poSku,
          poDescription: line.poDescription,
          poUnitPrice: unitPrice,
          orderedAvailable: number(line.availableOrderedQuantity),
          receivedAvailable: number(line.availableReceivedQuantity),
          orderedQuantity: line.orderedQuantity ? number(line.orderedQuantity) : undefined,
          receivedQuantity: line.receivedQuantity ? number(line.receivedQuantity) : undefined,
          previouslyInvoicedQuantity: line.previouslyInvoicedQuantity ? number(line.previouslyInvoicedQuantity) : undefined,
          remainingPoValue: number(candidate.remainingPoBasisValue),
          priceVariancePct: 0,
          amountDifference: number(candidate.subtotalDifference),
        };
      }),
    })),
    bundleCandidates: detail.bundleCandidates.map((candidate) => ({
      candidateId: candidate.id,
      invoiceItemDescription: inv?.lines[candidate.invoiceLineIndex]?.description ?? "Invoice bundle",
      invoiceItemSku: inv?.lines[candidate.invoiceLineIndex]?.sku,
      invoiceQuantity: number(candidate.bundleQuantity),
      poNumber: detail.candidatePo ?? inv?.poNumber ?? "",
      totalPoBasis: number(candidate.totalPoBasisAmount),
      components: candidate.components.map((component) => ({
        poLineId: component.poLineId,
        sku: component.sku,
        description: component.description ?? component.sku,
        uom: component.uom,
        quantity: number(component.quantity),
        unitPrice: number(component.unitPrice),
        poBasis: number(component.poBasisAmount),
        orderedAvailable: number(component.availableOrderedQuantity),
        receivedAvailable: number(component.availableReceivedQuantity),
      })),
    })),
    allocation: detail.allocations.length
      ? {
          method: detail.allocations.some((item) => item.matchType === "BUNDLE_CONFIRMED")
            ? "REVIEWER_CONFIRMED_BUNDLE"
            : detail.allocations.some((item) => item.matchType === "BUNDLE_MASTER")
              ? "TRUSTED_BUNDLE"
              : "DIRECT_PO_LINE",
          explanation:
            detail.allocations
              .map((item) => item.matchReason)
              .filter(Boolean)
              .join(" ") || "Invoice lines matched the purchase order.",
          lines: detail.allocations.map((item) => {
            const quantity = number(item.quantity);
            const orderedAfter = number(item.remainingOrderedQuantity);
            const receivedAfter = number(item.remainingReceivedQuantity);
            return {
              invoiceSku: inv?.lines[item.invoiceLineIndex]?.sku ?? item.sku,
              invoiceDescription: inv?.lines[item.invoiceLineIndex]?.description ?? item.poDescription ?? item.sku,
              requestedQuantity: quantity,
              uom: inv?.lines[item.invoiceLineIndex]?.uom ?? "",
              poNumber: item.poNumber,
              poLineId: item.poLineId,
              poSku: item.sku,
              poDescription: item.poDescription ?? item.sku,
              poUnitPrice: number(item.poUnitPrice),
              poBasis: number(item.poBasisAmount),
              orderedQuantity: item.orderedQuantity ? number(item.orderedQuantity) : undefined,
              receivedQuantity: item.receivedQuantity ? number(item.receivedQuantity) : undefined,
              previouslyInvoicedQuantity: item.previouslyInvoicedQuantity ? number(item.previouslyInvoicedQuantity) : undefined,
              orderedBefore: number(item.availableOrderedQuantity) || orderedAfter + quantity,
              orderedAfter,
              receivedBefore: number(item.availableReceivedQuantity) || receivedAfter + quantity,
              receivedAfter,
              bundleDefinitionId: item.bundleDefinitionId,
            };
          }),
        }
      : undefined,
    capacityIssues: failedChecks.flatMap((check) => {
      const value = calculation(check);
      if (value?.kind !== "RECEIPT_CAPACITY") return [];
      return [
        {
          poNumber: inv?.poNumber ?? "",
          sku: value.sku,
          description: check.detail,
          uom: value.uom,
          requested: value.requestedQuantity,
          receivedAvailable: value.receivedAvailability,
          orderedAvailable: value.orderedAvailability,
          shortfall: value.shortfall,
        },
      ];
    }),
    checks: detail.checks.map((check) => ({
      code: check.code,
      name: text(check.code),
      category: category(check.category),
      pass: check.passed,
      explanation: check.detail,
      expected: check.expected ?? undefined,
      observed: check.actual ?? undefined,
      evidenceRef: check.sourceIds?.[0],
      sourceRefs: check.sourceIds,
      calculation: calculation(check),
    })),
    evidence: detail.evidence.map((item) => ({
      id: item.id,
      content: item.content,
      confidence: item.confidence,
      page: item.page,
      label: item.label,
    })),
    aiRechecks: (detail.aiRechecks ?? []).map((recheck) => ({
      field: recheck.field,
      originalOcrValue: recheck.originalOcrValue,
      ocrConfidence: recheck.ocrConfidence,
      sourceId: recheck.sourceId,
      page: recheck.page,
      aiValue: recheck.aiValue,
      model: recheck.model,
      attemptedAt: recheck.attemptedAt,
      outcome: recheck.outcome,
    })),
    activity: activity(detail),
    extractionError: detail.reasonCode === "EXTRACTION_FAILED" ? (detail.nextAction ?? undefined) : undefined,
    mappingError: detail.reasonCode === "MAPPING_FAILED" ? (detail.nextAction ?? undefined) : undefined,
    issueCount: failedChecks.length || undefined,
  };
}

export function toUiSummary(summary: RunSummary): Run {
  return {
    runId: summary.runId,
    filename: summary.filename,
    state: summary.state,
    execution: summary.execution ?? "PENDING",
    reasonCode: reasonCode(summary.reasonCode),
    nextAction: null,
    ledgerId: summary.ledgerId,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    stages: [],
    invoice:
      summary.invoiceNumber || summary.vendor || summary.total
        ? {
            vendor: summary.vendor ?? "Unknown vendor",
            invoiceNumber: summary.invoiceNumber ?? summary.filename,
            invoiceDate: null,
            poNumber: summary.poNumber ?? null,
            currency: summary.currency ?? "USD",
            observedSubtotal: number(summary.total),
            observedTax: 0,
            observedTotal: number(summary.total),
            normalizedSubtotal: number(summary.total),
            normalizedTax: 0,
            normalizedTotal: number(summary.total),
            taxTreatment: "EXCLUSIVE",
            lines: [],
          }
        : null,
    checks: [],
    activity: [],
  };
}
