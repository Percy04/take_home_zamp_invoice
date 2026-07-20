import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import type { Run, RunState } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { InvoiceUploadDialog } from "@/components/InvoiceUploadDialog";
import { dateLong, money } from "@/lib/format";
import { useStore } from "@/lib/store";
import { reviewRoute } from "@/lib/review-issues";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Invoices — AP Resolution" },
      {
        name: "description",
        content: "Review processing outcomes and resolve invoices that need attention.",
      },
    ],
  }),
  component: Dashboard,
});

const FILTERS: Array<{ key: RunState | "ALL"; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "NEEDS_REVIEW", label: "Needs review" },
  { key: "PROCESSING", label: "Processing" },
  { key: "POSTED", label: "Posted" },
];

function Dashboard() {
  const runs = useStore((s) => s.runs);
  const [filter, setFilter] = useState<RunState | "ALL">("ALL");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [uploadOpen, setUploadOpen] = useState(false);
  const perPage = 25;

  useEffect(() => {
    api.listRuns().then(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    return runs
      .filter((r) => {
        if (filter !== "ALL" && r.state !== filter) return false;
        return true;
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [runs, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  const summary = useMemo(() => {
    const total = runs.length;
    const posted = runs.filter((r) => r.state === "POSTED").length;
    const review = runs.filter(
      (r) => r.state === "NEEDS_REVIEW" || r.state === "AWAITING_PO_CONFIRMATION" || r.state === "AWAITING_BUNDLE_CONFIRMATION",
    ).length;
    const postedValue = runs
      .filter((r) => r.state === "POSTED")
      .reduce((total, r) => total + (r.invoice?.normalizedTotal ?? r.invoice?.observedTotal ?? 0), 0);
    return { total, posted, review, postedValue };
  }, [runs]);

  return (
    <div className="mx-auto max-w-[1500px]">
      <header className="flex flex-wrap items-start justify-between gap-6 pb-7 pt-2">
        <div>
          <p className="eyebrow">Invoices</p>
          <h1 className="mt-1 font-serif text-[31px] leading-none tracking-tight text-foreground">Recent invoice runs</h1>
        </div>
        <div className="flex flex-wrap items-start gap-6">
          <dl className="grid grid-cols-3 gap-x-7 pt-2 text-left sm:text-right">
            <Metric label="Requires attention" value={summary.review.toString()} tone="warn" />
            <Metric label="Posted" value={summary.posted.toString()} tone="success" />
            <Metric label="Posted value" value={money(summary.postedValue)} />
          </dl>
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className="rounded-md bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90"
          >
            Add invoice
          </button>
        </div>
      </header>

      <InvoiceUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />

      <nav aria-label="Invoice status" className="mb-4 flex overflow-x-auto border-b border-border">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => {
              setFilter(f.key);
              setPage(1);
            }}
            className={`shrink-0 border-b-2 px-2.5 py-2.5 text-[12px] font-medium transition-colors ${
              filter === f.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label} <span className="ml-0.5 font-mono text-[10.5px]">{filterCount(runs, f.key)}</span>
          </button>
        ))}
      </nav>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface-muted text-[11.5px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <Th>Status</Th>
                <Th>Vendor · invoice</Th>
                <Th>PO</Th>
                <Th className="text-right">Total</Th>
                <Th>Primary reason</Th>
                <Th>Received</Th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12">
                    <div className="mx-auto max-w-sm text-center">
                      <div className="mx-auto mb-3 h-10 w-10 rounded-full bg-surface-muted" aria-hidden />
                      <div className="text-[13.5px] font-medium">Workspace is empty</div>
                      <div className="mt-1 text-[12.5px] text-muted-foreground">
                        Add an invoice to start matching and reviewing AP activity.
                      </div>
                    </div>
                  </td>
                </tr>
              ) : loading && pageItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    Loading invoices…
                  </td>
                </tr>
              ) : !loading && pageItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12">
                    <div className="mx-auto max-w-sm text-center">
                      <div className="mx-auto mb-3 h-10 w-10 rounded-full bg-surface-muted" aria-hidden />
                      <div className="text-[13.5px] font-medium">No invoices match this view</div>
                      <div className="mt-1 text-[12.5px] text-muted-foreground">Try a different status.</div>
                    </div>
                  </td>
                </tr>
              ) : (
                pageItems.map((r) => <RunRow key={r.runId} run={r} />)
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > perPage && (
          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
            <div>
              Showing <span className="tabular">{(page - 1) * perPage + 1}</span>–
              <span className="tabular">{Math.min(page * perPage, filtered.length)}</span> of{" "}
              <span className="tabular">{filtered.length}</span>
            </div>
            <div className="flex gap-1">
              <button
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
                className="rounded border border-border px-2 py-1 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                disabled={page === totalPages}
                onClick={() => setPage(page + 1)}
                className="rounded border border-border px-2 py-1 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`px-3 py-2.5 font-medium ${className}`}>
      {children}
    </th>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warn" | "success" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={`mt-1 font-mono text-[15px] font-medium tabular ${tone === "warn" ? "text-destructive" : tone === "success" ? "text-success" : "text-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}

function RunRow({ run }: { run: Run }) {
  const reason = primaryReason(run);
  return (
    <tr className="relative cursor-pointer border-t border-border hover:bg-surface-muted/60 focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-primary">
      <td className="px-3 py-3 align-top">
        <StatusBadge state={run.state} size="sm" />
      </td>
      <td className="px-3 py-3 align-top">
        <Link
          to="/runs/$runId"
          params={{ runId: run.runId }}
          className="text-[13px] font-medium text-foreground after:absolute after:inset-0 after:content-[''] hover:text-primary hover:underline focus:outline-none"
        >
          {run.invoice?.vendor ?? "Unknown vendor"}
        </Link>
        <div className="font-mono text-[11px] text-muted-foreground">{run.invoice?.invoiceNumber ?? "—"}</div>
      </td>
      <td className="px-3 py-3 align-top font-mono text-[11px]">{run.invoice?.poNumber ?? "—"}</td>
      <td className="px-3 py-3 align-top text-right font-mono tabular">
        {money(run.invoice?.normalizedTotal ?? run.invoice?.observedTotal, run.invoice?.currency ?? "USD")}
      </td>
      <td className="px-3 py-3 align-top text-[12px] text-muted-foreground">
        {run.reasonCode && <strong className="block text-[10px] uppercase tracking-wide text-muted-foreground">{reviewRoute(run)}</strong>}
        {reason}
      </td>
      <td className="px-3 py-3 align-top font-mono text-[11px] text-muted-foreground tabular">{dateLong(run.updatedAt)}</td>
    </tr>
  );
}

function primaryReason(r: Run): string {
  if (r.state === "POSTED") return r.ledgerId ?? "Posted";
  switch (r.reasonCode) {
    case "APPROVED_DIRECT":
      return "Invoice and purchase order comparison";
    case "APPROVED_BUNDLE":
      return "Trusted bundle";
    case "APPROVED_REVIEWER_BUNDLE":
      return "Reviewer-confirmed bundle";
    case "APPROVED_TAX_INCLUSIVE":
      return "Tax normalized, direct match";
    case "DUPLICATE_INVOICE":
      return "Possible duplicate invoice";
    case "AMBIGUOUS_DATE":
      return "Invoice date needs confirmation";
    case "MISSING_FIELD":
      return r.invoice?.missingFields?.[0] === "invoiceDate" ? "Invoice date missing" : "Missing required field";
    case "MISSING_PO":
      return "Select the purchase order";
    case "RECEIPT_CAPACITY_EXCEEDED":
      return "Quantity exceeds received goods";
    case "PRICE_VARIANCE_EXCEEDED":
      return "Price differs from PO";
    case "UNKNOWN_BUNDLE":
      return "Invoice item needs a component mapping";
    case "MULTIPLE_ISSUES":
      return "Price variance and receipt shortfall";
    case "EXTRACTION_FAILED":
      return "Document could not be read";
    case "MAPPING_FAILED":
      return "Details could not be linked";
    case "LOW_CONFIDENCE":
      return "Document extraction issue";
    default:
      return r.state === "PROCESSING" ? "Processing…" : "—";
  }
}

function filterCount(runs: Run[], filter: RunState | "ALL") {
  return filter === "ALL" ? runs.length : runs.filter((run) => run.state === filter).length;
}
