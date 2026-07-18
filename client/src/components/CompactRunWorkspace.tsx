import { Link } from "@tanstack/react-router";
import { DocumentPreview } from "@/components/DocumentPreview";
import { DecisionEvidence } from "@/components/DecisionEvidence";
import { money, relTime } from "@/lib/format";
import type { Run } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";

export function CompactRunWorkspace({ run, children }: { run: Run; children: React.ReactNode }) {
  const invoice = run.invoice;
  const total = invoice?.normalizedTotal ?? invoice?.observedTotal;

  return (
    <article className="mx-auto max-w-[1500px]">
      <div className="grid items-start gap-4 xl:items-stretch xl:grid-cols-[minmax(0,1fr)_400px]">
        <header className="compact-run-header min-w-0">
          <nav aria-label="Breadcrumb" className="text-[12px] text-muted-foreground">
            <Link to="/dashboard" className="hover:text-foreground hover:underline">
              Activity
            </Link>
            <span className="mx-1.5">/</span>
            <span className="font-mono text-foreground">{run.runId.slice(0, 8)}</span>
          </nav>
          <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px] lg:items-start">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge state={run.state} size="sm" />
              </div>
              <h1 className="mt-2 truncate font-serif text-[27px] leading-none tracking-tight text-foreground">
                {invoice?.vendor ?? invoice?.invoiceNumber ?? run.filename}
              </h1>
              <p className="mt-2 text-[12.5px] text-muted-foreground">
                Invoice <span className="font-mono text-foreground">{invoice?.invoiceNumber ?? "—"}</span>
                <span className="mx-2">·</span>
                PO <span className="font-mono text-foreground">{invoice?.poNumber ?? "Not found"}</span>
                <span className="mx-2">·</span>
                Updated {relTime(run.updatedAt)}
              </p>
            </div>
            <div className="lg:text-right">
              <div className="eyebrow">Invoice total</div>
              <div className="mt-1 font-mono text-[25px] font-semibold tabular text-foreground">{money(total, invoice?.currency)}</div>
            </div>
          </div>
        </header>
        <div className="min-w-0 space-y-4 xl:col-start-1">
          {needsDecisionEvidence(run) && <DecisionEvidence run={run} />}
          {children}
        </div>
        <aside className="bg-surface-muted xl:col-start-2 xl:self-stretch">
          <DocumentPreview run={run} compact />
        </aside>
      </div>
    </article>
  );
}

function needsDecisionEvidence(run: Run) {
  return (
    run.state === "NEEDS_REVIEW" ||
    run.state === "AWAITING_PO_CONFIRMATION" ||
    run.state === "AWAITING_BUNDLE_CONFIRMATION" ||
    run.reasonCode === "DUPLICATE_INVOICE" ||
    run.reasonCode === "MISSING_FIELD" ||
    run.reasonCode === "LOW_CONFIDENCE" ||
    run.reasonCode === "MULTIPLE_ISSUES" ||
    Boolean(run.capacityIssues?.length)
  );
}
