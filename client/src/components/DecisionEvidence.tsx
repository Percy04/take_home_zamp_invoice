import { useState } from "react";
import type { ReactNode } from "react";
import type { AiRecheck, Run } from "@/lib/types";
import { money, qty, dateLong } from "@/lib/format";
import * as api from "@/lib/api";
import {
  isExtractionIssue,
  reviewChecks,
  reviewIssues,
  reviewRoute,
  reviewSummary,
  type ReviewIssue,
} from "@/lib/review-issues";

export function DecisionEvidence({ run }: { run: Run }) {
  const inv = run.invoice;
  const summary = reviewSummary(run);
  const invoiceDataIssues = reviewIssues(run).filter((issue) => issue.category === "INVOICE_DATA");
  const unresolvedRechecks =
    run.aiRechecks?.filter((recheck) => recheck.outcome === "needs_review") ?? [];
  const extractionIssue = isExtractionIssue(run);

  return (
    <section aria-label="Decision evidence" className="panel p-0">
      <header className="border-b border-border px-4 py-2.5">
        <p className="eyebrow">{reviewRoute(run)}</p>
        <h3 className="mt-0.5 text-[14px] font-semibold text-foreground">
          {extractionIssue ? "Document extraction issue" : (summary?.title ?? headerFor(run))}
        </h3>
        {!extractionIssue && summary?.explanation && (
          <p className="mt-1 text-[12px] text-muted-foreground">{summary.explanation}</p>
        )}
      </header>
      <div className="p-4">
        {run.state === "PROCESSING" && (
          <p className="text-[13px] text-muted-foreground">
            Evidence will appear here as reading and matching complete.
          </p>
        )}

        {unresolvedRechecks.length > 0 && <ExtractionEvidence rechecks={unresolvedRechecks} />}
        {!unresolvedRechecks.length && invoiceDataIssues.length > 0 && (
          <InvoiceDataEvidence issues={invoiceDataIssues} />
        )}
        {run.reasonCode === "DUPLICATE_INVOICE" && <DuplicateEvidenceBlock run={run} />}
        {run.reasonCode === "MISSING_PO" && run.state === "AWAITING_PO_CONFIRMATION" && (
          <PoCandidateBlock run={run} />
        )}
        {run.reasonCode === "UNKNOWN_BUNDLE" && run.state === "AWAITING_BUNDLE_CONFIRMATION" && (
          <BundleCandidateBlock run={run} />
        )}
        {run.state === "NEEDS_REVIEW" &&
          (run.reasonCode === "MISSING_PO" || run.reasonCode === "UNKNOWN_BUNDLE") && (
            <ManualReviewNotice run={run} />
          )}
        {run.state === "NEEDS_REVIEW" && <IndependentIssues run={run} />}
        {(run.reasonCode === "APPROVED_DIRECT" ||
          run.reasonCode === "APPROVED_BUNDLE" ||
          run.reasonCode === "APPROVED_REVIEWER_BUNDLE") &&
          run.allocation && <MatchEvidenceTable run={run} />}
        {run.reasonCode === "APPROVED_TAX_INCLUSIVE" && (
          <>
            <TaxNormalizationBlock run={run} />
            {run.allocation && (
              <div className="mt-4">
                <MatchEvidenceTable run={run} />
              </div>
            )}
          </>
        )}
        {run.reasonCode === "EXTRACTION_FAILED" && (
          <div className="text-[13px] text-muted-foreground">
            <p>{run.extractionError}</p>
            <p className="mt-2">
              Try uploading a clearer copy. The original PDF is still available below.
            </p>
          </div>
        )}
        {run.reasonCode === "MAPPING_FAILED" && inv && (
          <div>
            <p className="text-[13px] text-muted-foreground">{run.mappingError}</p>
            <div className="mt-3 grid gap-2 rounded-md border border-border p-3 text-[13px] sm:grid-cols-2">
              <Kv label="Extracted vendor text" value={inv.vendor} />
              <Kv label="Extracted invoice #" value={inv.invoiceNumber} />
              <Kv label="Extracted date" value={dateLong(inv.invoiceDate)} />
              <Kv
                label="Extracted total"
                value={money(inv.observedTotal, inv.currency)}
                className="tabular"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function headerFor(run: Run): string {
  switch (run.reasonCode) {
    case "APPROVED_DIRECT":
      return "Invoice and purchase order comparison";
    case "APPROVED_BUNDLE":
      return "Trusted bundle definition";
    case "APPROVED_REVIEWER_BUNDLE":
      return "Reviewer-confirmed bundle";
    case "APPROVED_TAX_INCLUSIVE":
      return "Tax normalization and direct PO match";
    case "DUPLICATE_INVOICE":
      return "Compare with existing posting";
    case "MISSING_FIELD":
      return "Missing required field";
    case "LOW_CONFIDENCE":
      return "Low-confidence extraction";
    case "MISSING_PO":
      return "Suggested purchase order";
    case "UNKNOWN_BUNDLE":
      return "Proposed component decomposition";
    case "RECEIPT_CAPACITY_EXCEEDED":
      return "Receipt quantity mismatch";
    case "MULTIPLE_ISSUES":
      return "Independent issues detected";
    case "EXTRACTION_FAILED":
      return "Document could not be read";
    case "MAPPING_FAILED":
      return "Details could not be linked";
    default:
      return "Evidence";
  }
}

function Kv({
  label,
  value,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-[13px] text-foreground ${className}`}>{value}</div>
    </div>
  );
}

function ExtractionEvidence({ rechecks }: { rechecks: AiRecheck[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-[12.5px]">
        <thead className="bg-surface-muted text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">Field</th>
            <th className="px-3 py-2 text-left">OCR reading</th>
            <th className="px-3 py-2 text-right">OCR confidence</th>
            <th className="px-3 py-2 text-left">AI re-read</th>
            <th className="px-3 py-2 text-left">Source/page</th>
            <th className="px-3 py-2 text-left">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rechecks.map((recheck) => (
            <tr key={`${recheck.field}-${recheck.attemptedAt}`} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{fieldLabel(recheck.field)}</td>
              <td className="px-3 py-2 font-mono">{recheck.originalOcrValue || "—"}</td>
              <td className="px-3 py-2 text-right font-mono tabular">
                {recheck.ocrConfidence === null
                  ? "—"
                  : `${Math.round(recheck.ocrConfidence * 100)}%`}
              </td>
              <td className="px-3 py-2">{recheck.aiValue ?? "No usable value"}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {recheck.sourceId} · {recheck.page ? `Page ${recheck.page}` : "Page unknown"}
              </td>
              <td className="px-3 py-2 text-destructive">Needs review</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceDataEvidence({ issues }: { issues: ReviewIssue[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-[12.5px]">
        <thead className="bg-surface-muted text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">Field</th>
            <th className="px-3 py-2 text-left">Issue</th>
            <th className="px-3 py-2 text-left">Extracted value</th>
            <th className="px-3 py-2 text-right">Confidence</th>
            <th className="px-3 py-2 text-left">Source</th>
            <th className="px-3 py-2 text-left">Required action</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={`${issue.field}-${issue.title}`} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{issue.field ?? "Invoice fields"}</td>
              <td className="px-3 py-2 text-destructive">{issue.condition ?? issue.title}</td>
              <td className="px-3 py-2 font-mono">{issue.value ?? "—"}</td>
              <td className="px-3 py-2 text-right font-mono tabular">
                {issue.confidence === null || issue.confidence === undefined
                  ? "—"
                  : `${Math.round(issue.confidence * 100)}%`}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{issue.source ?? "—"}</td>
              <td className="px-3 py-2">{issue.action ?? "Review the extracted values."}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fieldLabel(field: string) {
  const line = field.match(/^lines\.(\d+)\.(.+)$/);
  if (line) return `Line ${Number(line[1]) + 1} ${line[2].replace(/([A-Z])/g, " $1")}`;
  return field.replaceAll(".", " ").replace(/([A-Z])/g, " $1");
}

function DuplicateEvidenceBlock({ run }: { run: Run }) {
  const d = run.duplicateMatch!;
  const inv = run.invoice!;
  const comparisons = [
    ["Vendor", inv.vendor, d.vendor],
    ["Invoice number", inv.invoiceNumber, d.originalInvoiceNumber],
    ["PO", inv.poNumber ?? "—", d.poNumber],
    ["Total", money(inv.normalizedTotal, inv.currency), money(d.total, inv.currency)],
    ["Posting reference", "—", readablePostingReference(d)],
    ["Original posting date", "—", dateLong(d.postedAt)],
  ];
  return (
    <div>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-muted text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Field</th>
              <th className="px-3 py-2 text-left">This invoice</th>
              <th className="px-3 py-2 text-left">Existing posting</th>
              <th className="px-3 py-2 text-right">Match</th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map(([field, current, existing], index) => {
              const comparable = index < 4;
              const matches = current === existing;
              return (
                <tr key={field} className="border-t border-border">
                  <td className="px-3 py-2 text-muted-foreground">{field}</td>
                  <td className="px-3 py-2 font-mono text-foreground">{current}</td>
                  <td className="px-3 py-2 font-mono text-foreground">{existing}</td>
                  <td className="px-3 py-2 text-right text-[11px]">
                    {comparable ? (
                      <span className={matches ? "text-success" : "text-destructive"}>
                        {matches ? "✓ identical" : "! differs"}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12px] text-muted-foreground">
        Duplicates cannot be overridden from this screen. Investigate the source of the
        resubmission.
      </p>
    </div>
  );
}

function PoCandidateBlock({ run }: { run: Run }) {
  const c = run.poCandidates?.[0];
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string>();
  if (!c) return null;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mt-0.5 text-[14px] font-semibold text-foreground">
            <span className="font-mono">{c.poNumber}</span> · {c.vendor}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            disabled={!!busy}
            onClick={async () => {
              setBusy("reject");
              setActionError(undefined);
              try {
                await api.rejectPo(run.runId);
              } catch (caught) {
                setActionError(
                  caught instanceof Error ? caught.message : "Could not reject the purchase order.",
                );
              } finally {
                setBusy(null);
              }
            }}
            className="rounded border border-border bg-surface px-3 py-1.5 text-[12px] font-medium hover:bg-muted disabled:opacity-60"
          >
            {busy === "reject" ? "Rejecting…" : "Reject suggestion"}
          </button>
          <button
            disabled={!!busy}
            onClick={async () => {
              setBusy("confirm");
              setActionError(undefined);
              try {
                await api.confirmPo(run.runId, c.poNumber);
              } catch (caught) {
                setActionError(
                  caught instanceof Error
                    ? caught.message
                    : "Could not confirm the purchase order.",
                );
              } finally {
                setBusy(null);
              }
            }}
            className="rounded bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {busy === "confirm" ? "Confirming…" : `Confirm ${c.poNumber}`}
          </button>
        </div>
      </div>
      {actionError && (
        <p role="alert" className="mb-3 text-[12px] text-destructive">
          {actionError}
        </p>
      )}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-muted text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Invoice item</th>
              <th className="px-3 py-2 text-left">PO item</th>
              <th className="px-3 py-2 text-right">This invoice</th>
              <th className="px-3 py-2 text-right">Available to invoice</th>
              <th className="px-3 py-2 text-right">Invoice price</th>
              <th className="px-3 py-2 text-right">PO price</th>
              <th className="px-3 py-2 text-right">Difference</th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((l) => (
              <tr key={l.poLineId} className="border-t border-border">
                <td className="px-3 py-2">
                  <div className="font-mono text-[11.5px]">{l.invoiceSku}</div>
                  <div>{l.invoiceDescription}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono text-[11.5px]">
                    {l.poSku} · {l.poLineId}
                  </div>
                  <div>{l.poDescription}</div>
                </td>
                <td className="px-3 py-2 text-right tabular">{qty(l.requestedQuantity, l.uom)}</td>
                <td className="px-3 py-2 text-right tabular">{qty(l.receivedAvailable, l.uom)}</td>
                <td className="px-3 py-2 text-right tabular">{money(l.invoiceUnitPrice)}</td>
                <td className="px-3 py-2 text-right tabular">{money(l.poUnitPrice)}</td>
                <td className="px-3 py-2 text-right tabular">
                  {money(l.amountDifference)}{" "}
                  <span className="text-muted-foreground">({l.priceVariancePct}%)</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BundleCandidateBlock({ run }: { run: Run }) {
  const b = run.bundleCandidates?.[0];
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string>();
  if (!b) return null;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mt-0.5 text-[13px] text-foreground">
            <span className="font-semibold">{b.invoiceItemDescription}</span>
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Suggested because the invoice item's description, quantity, and total align with these
            PO components.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            disabled={!!busy}
            onClick={async () => {
              setBusy("reject");
              setActionError(undefined);
              try {
                await api.rejectBundle(run.runId);
              } catch (caught) {
                setActionError(
                  caught instanceof Error ? caught.message : "Could not reject the decomposition.",
                );
              } finally {
                setBusy(null);
              }
            }}
            className="rounded border border-border bg-surface px-3 py-1.5 text-[12px] font-medium hover:bg-muted disabled:opacity-60"
          >
            {busy === "reject" ? "Rejecting…" : "Reject decomposition"}
          </button>
          <button
            disabled={!!busy}
            onClick={async () => {
              setBusy("confirm");
              setActionError(undefined);
              try {
                await api.confirmBundle(run.runId, b.candidateId);
              } catch (caught) {
                setActionError(
                  caught instanceof Error ? caught.message : "Could not confirm the decomposition.",
                );
              } finally {
                setBusy(null);
              }
            }}
            className="rounded bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {busy === "confirm" ? "Confirming…" : "Confirm decomposition"}
          </button>
        </div>
      </div>
      {actionError && (
        <p role="alert" className="mb-3 text-[12px] text-destructive">
          {actionError}
        </p>
      )}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-muted text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">PO item</th>
              <th className="px-3 py-2 text-left">Description</th>
              <th className="px-3 py-2 text-right">Quantity</th>
              <th className="px-3 py-2 text-right">Unit price</th>
              <th className="px-3 py-2 text-right">PO basis</th>
              <th className="px-3 py-2 text-right">Available to invoice</th>
            </tr>
          </thead>
          <tbody>
            {b.components.map((c) => (
              <tr key={c.poLineId} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-[11.5px]">
                  {c.sku} · {c.poLineId}
                </td>
                <td className="px-3 py-2">{c.description}</td>
                <td className="px-3 py-2 text-right tabular">{qty(c.quantity, c.uom)}</td>
                <td className="px-3 py-2 text-right tabular">{money(c.unitPrice)}</td>
                <td className="px-3 py-2 text-right tabular">{money(c.poBasis)}</td>
                <td className="px-3 py-2 text-right tabular">{qty(c.receivedAvailable, c.uom)}</td>
              </tr>
            ))}
            <tr className="border-t border-border bg-surface-muted">
              <td className="px-3 py-2 font-medium" colSpan={4}>
                Total PO basis
              </td>
              <td className="px-3 py-2 text-right font-semibold tabular">
                {money(b.totalPoBasis)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IndependentIssues({ run }: { run: Run }) {
  const capacityIssues = run.capacityIssues ?? [];
  const failures = reviewChecks(run).filter(
    (check) =>
      check.category !== "IDENTITY" &&
      check.code !== "LOW_CONFIDENCE" &&
      check.code !== "AMBIGUOUS_DATE" &&
      check.code !== "TOTAL_MISMATCH" &&
      !(run.reasonCode === "DUPLICATE_INVOICE" && check.category === "DUPLICATE") &&
      !(run.reasonCode === "MISSING_PO" && check.code === "MISSING_PO") &&
      !(run.reasonCode === "UNKNOWN_BUNDLE" && check.code === "LINE_MATCH") &&
      !(run.capacityIssues?.length && check.category === "CAPACITY"),
  );
  if (!capacityIssues.length && !failures.length) return null;
  return (
    <div className="space-y-2">
      {capacityIssues.map((issue, index) => (
        <ReviewIssueCard
          key={`${issue.poNumber}-${issue.sku}-${index}`}
          title="Quantity exceeds received goods"
        >
          <p>
            <span className="font-mono text-[11px]">{issue.poNumber}</span> ·{" "}
            <span className="font-mono text-[11px]">{issue.sku}</span> · {issue.description}
          </p>
          <p className="mt-1 font-mono text-[11px]">
            available {qty(issue.receivedAvailable, issue.uom)} · this invoice{" "}
            {qty(issue.requested, issue.uom)} · shortfall {qty(issue.shortfall, issue.uom)}
          </p>
        </ReviewIssueCard>
      ))}
      {failures.map((check) => (
        <ReviewIssueCard
          key={`${check.code}-${check.explanation}`}
          title={controlTitle(check.code, check.name)}
        >
          <p>{check.explanation}</p>
          {check.calculation?.kind === "PRICE_VARIANCE" && (
            <p className="mt-1 font-mono text-[11px]">
              invoice {money(check.calculation.invoiceUnitPrice)} · PO{" "}
              {money(check.calculation.poUnitPrice)}
              {` · ${money(check.calculation.varianceAmount)} total variance (${check.calculation.variancePercent}% vs ${check.calculation.tolerancePercent}% tolerance)`}
            </p>
          )}
          {(check.expected || check.observed) && (
            <p className="mt-1 font-mono text-[11px]">
              {check.expected && `expected ${check.expected}`}
              {check.expected && check.observed && " · "}
              {check.observed && `observed ${check.observed}`}
            </p>
          )}
        </ReviewIssueCard>
      ))}
    </div>
  );
}

function ReviewIssueCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details
      data-review-issue
      open
      className="overflow-hidden rounded-md border border-border bg-surface"
    >
      <summary className="cursor-pointer list-none bg-surface-muted px-3 py-2.5 text-[12.5px] font-semibold text-foreground marker:content-none">
        <span
          aria-hidden
          className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/70 align-middle"
        />
        {title}
      </summary>
      <div className="border-t border-border px-3 py-2.5 text-[12px] text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

function readablePostingReference(duplicate: NonNullable<Run["duplicateMatch"]>) {
  return `${duplicate.originalInvoiceNumber} · posted ${dateLong(duplicate.postedAt)}`;
}

function ManualReviewNotice({ run }: { run: Run }) {
  return (
    <p className="text-[12.5px] text-muted-foreground">
      <span className="font-medium text-foreground">Manual review required.</span>{" "}
      {run.nextAction ?? "No automatic decision will be applied."}
    </p>
  );
}

function controlTitle(code: string, fallback: string) {
  if (code === "PRICE_MATCH") return "Price differs from PO";
  if (code === "LINE_MATCH") return "Invoice item does not match the PO";
  if (code === "TOTAL_MISMATCH") return "Invoice lines do not match the total";
  return fallback;
}

function TaxNormalizationBlock({ run }: { run: Run }) {
  const inv = run.invoice!;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-md border border-border bg-surface-muted p-3">
        <div className="eyebrow">Observed on document</div>
        <p className="mt-1 text-[12px] text-muted-foreground">{inv.taxNote}</p>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px]">
          <dt className="text-muted-foreground">Gross unit price</dt>
          <dd className="tabular">
            {money(inv.lines[0]?.observedUnitPrice ?? inv.lines[0]?.unitPrice, inv.currency)}
          </dd>
          <dt className="text-muted-foreground">Gross amount</dt>
          <dd className="tabular">
            {money(inv.lines[0]?.observedAmount ?? inv.lines[0]?.amount, inv.currency)}
          </dd>
          <dt className="text-muted-foreground">Document total</dt>
          <dd className="tabular">{money(inv.observedTotal, inv.currency)}</dd>
        </dl>
      </div>
      <div className="rounded-md border border-border p-3">
        <div className="eyebrow">Normalized accounting values</div>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px]">
          <dt className="text-muted-foreground">Net unit price</dt>
          <dd className="tabular">{money(inv.lines[0]?.unitPrice, inv.currency)}</dd>
          <dt className="text-muted-foreground">Net subtotal</dt>
          <dd className="tabular">{money(inv.normalizedSubtotal, inv.currency)}</dd>
          <dt className="text-muted-foreground">Tax</dt>
          <dd className="tabular">{money(inv.normalizedTax, inv.currency)}</dd>
          <dt className="text-muted-foreground">Total</dt>
          <dd className="tabular">{money(inv.normalizedTotal, inv.currency)}</dd>
        </dl>
        <p className="mt-2 border-t border-border pt-2 text-[11.5px] text-muted-foreground">
          Calculation: {money(inv.observedTotal)} ÷ 1.18 = {money(inv.normalizedSubtotal)};{" "}
          {money(inv.observedTotal)} − {money(inv.normalizedSubtotal)} = {money(inv.normalizedTax)}.
        </p>
      </div>
    </div>
  );
}

function MatchEvidenceTable({ run }: { run: Run }) {
  const a = run.allocation!;
  const methodLabel: Record<string, string> = {
    DIRECT_PO_LINE: "Direct purchase order comparison",
    TRUSTED_BUNDLE: "Trusted bundle definition",
    REVIEWER_CONFIRMED_BUNDLE: "Reviewer-confirmed bundle",
  };
  return (
    <div>
      <div className="mb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="eyebrow">Matching method</div>
            <div className="mt-0.5 text-[13.5px] font-semibold text-foreground">
              {methodLabel[a.method]}
            </div>
          </div>
        </div>
        <p className="mt-1 text-[12.5px] text-muted-foreground">{a.explanation}</p>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-muted text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Invoice item</th>
              <th className="px-3 py-2 text-left">PO item</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">PO unit price</th>
              <th className="px-3 py-2 text-right">PO basis</th>
              <th className="px-3 py-2 text-right">Received (before → after)</th>
              <th className="px-3 py-2 text-right">Ordered (before → after)</th>
            </tr>
          </thead>
          <tbody>
            {a.lines.map((l, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-3 py-2">
                  <div className="font-mono text-[11.5px]">{l.invoiceSku}</div>
                  <div>{l.invoiceDescription}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono text-[11.5px]">
                    {l.poNumber} · {l.poLineId} · {l.poSku}
                  </div>
                  <div>{l.poDescription}</div>
                </td>
                <td className="px-3 py-2 text-right tabular">{qty(l.requestedQuantity, l.uom)}</td>
                <td className="px-3 py-2 text-right tabular">{money(l.poUnitPrice)}</td>
                <td className="px-3 py-2 text-right tabular">{money(l.poBasis)}</td>
                <td className="px-3 py-2 text-right tabular">
                  {l.receivedBefore} → {l.receivedAfter}
                </td>
                <td className="px-3 py-2 text-right tabular">
                  {l.orderedBefore} → {l.orderedAfter}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
