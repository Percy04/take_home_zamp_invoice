import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { lazy, Suspense } from "react";
import {
  confirmBundle,
  confirmPo,
  createRun,
  fixtureIds,
  getRun,
  listRuns,
  processRun,
  rejectPo,
  resetWorkspace,
  type FixtureId,
} from "./api";
import type {
  DuplicateMatch,
  InvoicePreview,
  RunDetail,
  SourceRef,
} from "../../shared/contracts";

const queryClient = new QueryClient();
const PdfPreview = lazy(() => import("./pdf-preview"));

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<InvoicePage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/runs/:runId" element={<RunPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function InvoicePage() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [fileError, setFileError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const create = useMutation({
    mutationFn: createRun,
    onSuccess: (run) => navigate(`/runs/${run.runId}`),
  });

  const chooseFile = (selected?: File) => {
    if (
      selected &&
      selected.type !== "application/pdf" &&
      !selected.name.toLowerCase().endsWith(".pdf")
    ) {
      setFile(undefined);
      setFileError("Only PDF files are accepted.");
    } else if (selected && selected.size > 10 * 1024 * 1024) {
      setFile(undefined);
      setFileError("File is too large. Maximum size is 10 MiB.");
    } else {
      setFile(selected);
      setFileError(undefined);
    }
  };

  return (
    <ConsoleShell>
      <main className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 md:px-8 md:py-8 lg:grid-cols-[minmax(0,1fr)_360px]" aria-labelledby="page-title">
        <div>
          <header className="mb-5">
            <p className="eyebrow">New invoice</p>
            <h1 id="page-title" className="mt-1 text-2xl font-semibold tracking-tight">Upload an invoice</h1>
            <p className="mt-1.5 max-w-2xl text-[13.5px] text-[var(--muted-foreground)]">
              Add a PDF to extract invoice details, match it to a purchase order and run accounting controls.
            </p>
          </header>

          <section
            aria-label="Invoice document"
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files?.[0]); }}
            className={`panel px-5 py-8 text-center transition-colors ${dragging ? "border-[var(--primary)] bg-[var(--primary-soft)]" : ""}`}
          >
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--primary-soft)] text-[var(--primary)]" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
            </div>
            <p className="mt-3 text-sm font-medium">Drop a PDF here or</p>
            <button type="button" className="secondary mt-2 min-h-0 px-3 py-1.5 text-[13px]" onClick={() => inputRef.current?.click()}>Choose file</button>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(event) => chooseFile(event.target.files?.[0])} />
            <p className="mt-2 text-xs text-[var(--muted-foreground)]">PDF only · Max 10 MiB</p>

            {file && (
              <div className="mx-auto mt-4 flex max-w-md items-center justify-between gap-3 rounded border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-left">
                <div className="min-w-0"><div className="truncate text-[13px] font-medium">{file.name}</div><div className="text-[11.5px] text-[var(--muted-foreground)]">{(file.size / 1024).toFixed(0)} KB</div></div>
                <button type="button" className="secondary min-h-0 border-0 bg-transparent px-0 text-xs" onClick={() => { chooseFile(); if (inputRef.current) inputRef.current.value = ""; }}>Remove</button>
              </div>
            )}
            {fileError && <p role="alert" className="mt-3 text-[12.5px] text-[var(--destructive)]">{fileError}</p>}
            {create.error && <p role="alert" className="mt-3 text-[12.5px] text-[var(--destructive)]">{create.error.message}</p>}
            <button disabled={!file || create.isPending} className="mt-5 min-h-0 px-4 py-2 text-[13px]" onClick={() => file && create.mutate(file)}>{create.isPending ? "Uploading…" : "Upload and process"}</button>
            <p role="note" className="mx-auto mt-4 max-w-xl text-xs leading-relaxed text-[var(--muted-foreground)]">
              The PDF is sent to Azure Document Intelligence. Only extracted invoice evidence is sent to the configured AI mapping provider.
            </p>
          </section>

          <section className="panel mt-4 p-4" aria-labelledby="workflow">
            <p className="eyebrow" id="workflow">What happens next</p>
            <ol className="mt-2 grid gap-2 sm:grid-cols-2">
              {[
                ["1", "Read invoice fields", "Vendor, invoice number, dates, lines and totals."],
                ["2", "Match vendor and PO", "Find the purchase order and vendor on file."],
                ["3", "Validate lines and capacity", "Prices, quantities, receipts and remaining PO value."],
                ["4", "Post or route for review", "Auto-post when controls pass; otherwise show the exact reason."],
              ].map(([number, title, description]) => (
                <li key={number} className="flex gap-3 rounded border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--primary-soft)] text-[11px] font-semibold text-[var(--primary)]">{number}</span>
                  <div><div className="text-[13px] font-medium">{title}</div><div className="text-xs text-[var(--muted-foreground)]">{description}</div></div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="panel h-fit p-4" aria-labelledby="demo-invoices">
          <p className="eyebrow">Demo workspace</p>
          <h2 id="demo-invoices" className="mt-1 text-base font-semibold">Try a sample invoice</h2>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">Run a prepared scenario through the real processing workflow.</p>
          <div className="mt-4 grid gap-2" aria-label="Fixture runs">
            {fixtureIds.map((fixtureId) => (
              <button key={fixtureId} className="secondary min-h-0 justify-between px-3 py-2 text-[12.5px]" disabled={create.isPending} onClick={() => create.mutate(fixtureId)}>
                {fixtureLabel(fixtureId)} <span aria-hidden="true">→</span>
              </button>
            ))}
          </div>
        </aside>
      </main>
    </ConsoleShell>
  );
}

function DashboardPage() {
  const [search, setSearch] = useSearchParams();
  const state = search.get("state") ?? "";
  const cursor = search.get("cursor") ?? "";
  const runs = useQuery({
    queryKey: ["runs", state, cursor],
    queryFn: () =>
      listRuns({ state: state || undefined, cursor: cursor || undefined }),
  });

  return (
    <ConsoleShell>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8" aria-labelledby="dashboard-title">
        <header className="flex flex-wrap items-end justify-between gap-4 pb-4">
          <div>
            <p className="eyebrow">Activity</p>
            <h1 id="dashboard-title" className="mt-1 text-2xl font-semibold tracking-tight">Invoices</h1>
            <p className="mt-1 max-w-2xl text-[13px] text-[var(--muted-foreground)]">Review processing outcomes and resolve invoices that need attention.</p>
          </div>
          <Link to="/" className="rounded bg-[var(--primary)] px-3 py-1.5 text-[13px] font-semibold text-[var(--primary-foreground)]">Upload invoice</Link>
        </header>

        {runs.data && (
          <section className="panel mb-4 grid grid-cols-2 divide-y divide-[var(--border)] sm:grid-cols-4 sm:divide-x sm:divide-y-0" aria-label="Dashboard metrics">
            <Metric
              label="All invoices"
              value={String(runs.data.metrics.totalRuns)}
            />
            <Metric
              label="Posted"
              value={String(runs.data.metrics.postedCount)}
              tone="ok"
            />
            <Metric
              label="Needs review"
              value={String(runs.data.metrics.reviewCount)}
              tone="warn"
            />
            <Metric
              label="Auto-clear rate"
              value={`${runs.data.metrics.autoClearRate}%`}
            />
          </section>
        )}

        <div className="panel mb-4 flex flex-wrap items-center gap-2 p-2">
            <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
              <span className="sr-only">Status</span>
              <select
                aria-label="Status"
                className="rounded border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--foreground)]"
                value={state}
                onChange={(event) => {
                  const next = new URLSearchParams();
                  if (event.target.value) next.set("state", event.target.value);
                  setSearch(next);
                }}
              >
                <option value="">All statuses</option>
                <option value="POSTED">Posted</option>
                <option value="NEEDS_REVIEW">Needs review</option>
                <option value="AWAITING_PO_CONFIRMATION">Awaiting PO</option>
                <option value="AWAITING_BUNDLE_CONFIRMATION">
                  Awaiting bundle
                </option>
                <option value="PROCESSING">Processing</option>
              </select>
            </label>
            <span className="ml-auto px-2 text-xs text-[var(--muted-foreground)]">
              {runs.data ? `${runs.data.items.length} ${runs.data.items.length === 1 ? "invoice" : "invoices"}` : "Loading invoice history…"}
            </span>
          </div>

        <section className="panel overflow-hidden" aria-labelledby="recent-runs-title">
          <h2 id="recent-runs-title" className="sr-only">Invoice activity</h2>
          {runs.isPending && (
            <p className="px-4 py-10 text-center text-[13px] text-[var(--muted-foreground)]">Loading invoices…</p>
          )}
          {runs.error && <p className="p-4 text-[var(--destructive)]">{runs.error.message}</p>}
          {runs.data?.items.length === 0 && (
            <div className="px-4 py-12 text-center">
              <strong className="text-[13.5px] font-medium">No invoices match this view</strong>
              <p className="mt-1 text-[12.5px] text-[var(--muted-foreground)]">Try a different filter or upload a new invoice.</p>
            </div>
          )}
          {runs.data && runs.data.items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="bg-[var(--surface-muted)] text-[11.5px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  <tr>
                    <th className="px-3 py-2.5">Invoice</th>
                    <th className="px-3 py-2.5">Vendor</th>
                    <th className="px-3 py-2.5 text-right">Amount</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Primary reason</th>
                    <th className="px-3 py-2.5">Updated</th>
                    <th className="sr-only">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.items.map((run) => (
                    <tr key={run.runId} className="border-t border-[var(--border)] hover:bg-[var(--surface-muted)]">
                      <td className="px-3 py-2.5 align-top">
                        <Link className="font-medium hover:text-[var(--primary)] hover:underline" to={`/runs/${run.runId}`}>{run.invoiceNumber ?? run.filename}</Link>
                        <div className="max-w-[220px] truncate text-[11.5px] text-[var(--muted-foreground)]">{run.filename}</div>
                      </td>
                      <td className="px-3 py-2.5 align-top text-[12.5px]">{run.vendor ?? "—"}</td>
                      <td className="px-3 py-2.5 text-right align-top tabular-nums">{run.total ? `$${run.total}` : "—"}</td>
                      <td className="px-3 py-2.5 align-top"><span className={`status-badge ${stateTone(run.state)}`}>{formatLabel(run.state)}</span></td>
                      <td className="px-3 py-2.5 align-top text-[12.5px] text-[var(--muted-foreground)]">
                        {run.reasonCode ? formatReason(run.reasonCode) : run.state === "PROCESSING" ? "Processing…" : "—"}
                      </td>
                      <td className="px-3 py-2.5 align-top text-xs text-[var(--muted-foreground)]">{formatDate(run.updatedAt)}</td>
                      <td className="px-3 py-2.5 text-right align-top">
                        <Link className="text-[12.5px] font-medium text-[var(--primary)] hover:underline" to={`/runs/${run.runId}`} aria-label={`Open ${run.filename}`}>Open →</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {runs.data && (cursor || runs.data.nextCursor) && (
            <div className="flex items-center justify-end gap-1 border-t border-[var(--border)] px-3 py-2">
              <button
                className="secondary min-h-0 px-2 py-1 text-xs"
                disabled={!cursor}
                onClick={() => {
                  const next = new URLSearchParams();
                  if (state) next.set("state", state);
                  setSearch(next);
                }}
              >
                First page
              </button>
              <button
                className="secondary min-h-0 px-2 py-1 text-xs"
                disabled={!runs.data.nextCursor}
                onClick={() => {
                  const next = new URLSearchParams();
                  if (state) next.set("state", state);
                  if (runs.data.nextCursor)
                    next.set("cursor", runs.data.nextCursor);
                  setSearch(next);
                }}
              >
                Next page
              </button>
            </div>
          )}
        </section>
      </main>
    </ConsoleShell>
  );
}

function RunPage() {
  const { runId = "" } = useParams();
  const processStarted = useRef(false);
  const [processError, setProcessError] = useState<string>();
  const [pdfView, setPdfView] = useState({ runId, page: 1 });
  const pdfPage = pdfView.runId === runId ? pdfView.page : 1;
  const setPdfPage = (page: number) => setPdfView({ runId, page });
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRun(runId),
    refetchInterval: (query) =>
      query.state.data?.state === "PROCESSING" ? 500 : false,
  });
  const refetchRun = run.refetch;
  const poConfirmation = useMutation({
    mutationFn: (poNumber: string) => confirmPo(runId, poNumber),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const poRejection = useMutation({
    mutationFn: () => rejectPo(runId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const bundleConfirmation = useMutation({
    mutationFn: (candidateId: string) => confirmBundle(runId, candidateId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  useEffect(() => {
    if (
      run.data?.state !== "PROCESSING" ||
      processStarted.current ||
      processError
    )
      return;
    processStarted.current = true;
    setProcessError(undefined);
    void processRun(runId)
      .then((result) => queryClient.setQueryData(["run", runId], result))
      .catch((caught: unknown) => {
        setProcessError(
          caught instanceof Error
            ? caught.message
            : "The invoice could not be processed.",
        );
        void refetchRun();
      });
  }, [processError, run.data?.state, refetchRun, runId]);

  if (run.isPending) return <StatusPage>Loading run...</StatusPage>;
  if (run.error || !run.data)
    return <StatusPage>{run.error?.message ?? "Run not found."}</StatusPage>;
  const detail = run.data;
  const isPosted = detail.state === "POSTED";
  const outcome = describeOutcome(detail);

  return (
    <ConsoleShell>
      <main className="console-main run-layout">
        <div className="invoice-header">
          <div>
            <p className="breadcrumb">
              <Link to="/dashboard">Invoices</Link>
              <span>/</span>
              {detail.invoice?.invoiceNumber ?? detail.filename}
            </p>
            <h1>{detail.invoice?.invoiceNumber ?? detail.filename}</h1>
            <p className="summary">{detail.filename}</p>
          </div>
          <div className="invoice-header-actions">
            <span className={`status-badge ${stateTone(detail.state)}`}>
              {formatLabel(detail.state)}
            </span>
          </div>
        </div>

        <section
          className={`outcome-panel ${outcome.tone}`}
          aria-labelledby="outcome-title"
        >
          <div>
            <p className="eyebrow">Invoice result</p>
            <h2 id="outcome-title">{outcome.title}</h2>
            <p>{outcome.description}</p>
            {detail.nextAction &&
              !isPosted &&
              !detail.state.startsWith("AWAITING") && (
                <p className="outcome-action">
                  <strong>Next step:</strong> {detail.nextAction}
                </p>
              )}
          </div>
          {detail.state === "AWAITING_PO_CONFIRMATION" && detail.candidatePo ? (
            <aside className="resolution-action" aria-label="PO confirmation">
              <div>
                <p className="eyebrow">Reviewer action</p>
                <strong>{detail.candidatePo}</strong>
              </div>
              <div className="confirmation-actions">
                <button
                  className="secondary"
                  disabled={poConfirmation.isPending || poRejection.isPending}
                  onClick={() => poRejection.mutate()}
                >
                  {poRejection.isPending ? "Declining..." : "Not this PO"}
                </button>
                <button
                  disabled={poConfirmation.isPending || poRejection.isPending}
                  onClick={() => poConfirmation.mutate(detail.candidatePo!)}
                >
                  {poConfirmation.isPending ? "Confirming..." : "Confirm"}
                </button>
              </div>
              {(poConfirmation.error || poRejection.error) && (
                <p className="error">
                  {(poConfirmation.error ?? poRejection.error)?.message}
                </p>
              )}
            </aside>
          ) : detail.state === "AWAITING_BUNDLE_CONFIRMATION" &&
            detail.bundleCandidates[0] ? (
            <aside
              className="resolution-action"
              aria-label="Bundle confirmation"
            >
              <div>
                <p className="eyebrow">Reviewer action</p>
                <strong>Confirm decomposition</strong>
                <span>
                  {detail.bundleCandidates[0].components
                    .map(
                      (component) => `${component.quantity} ${component.sku}`,
                    )
                    .join(" · ")}
                </span>
              </div>
              <button
                disabled={bundleConfirmation.isPending}
                onClick={() =>
                  bundleConfirmation.mutate(detail.bundleCandidates[0]!.id)
                }
              >
                {bundleConfirmation.isPending ? "Confirming..." : "Confirm"}
              </button>
              {bundleConfirmation.error && (
                <p className="error">{bundleConfirmation.error.message}</p>
              )}
            </aside>
          ) : detail.ledgerId ? (
            <div className="ledger-reference">
              <span>Ledger reference</span>
              <strong>{detail.ledgerId}</strong>
            </div>
          ) : null}
        </section>

        {processError && detail.state === "PROCESSING" && (
          <section className="surface processing-error" role="alert">
            <div>
              <strong>Processing status unavailable</strong>
              <p>{processError}</p>
              <p>The server may still be processing this invoice.</p>
            </div>
            <button
              type="button"
              onClick={() => {
                processStarted.current = false;
                setProcessError(undefined);
              }}
            >
              Refresh status
            </button>
          </section>
        )}

        {detail.state === "PROCESSING" ? (
          <ProcessingActivity detail={detail} />
        ) : !detail.state.startsWith("AWAITING") ? (
          <DecisionExplanation detail={detail} />
        ) : null}

        {detail.invoicePreview && !detail.invoice && (
          <PartialInvoiceEvidence
            preview={detail.invoicePreview}
            reasonCode={detail.reasonCode}
          />
        )}

        {detail.duplicateMatch && (
          <DuplicateEvidence match={detail.duplicateMatch} />
        )}

        {detail.poCandidates.length > 0 && (
          <section
            className="surface evidence-panel"
            aria-labelledby="po-candidates"
          >
            <div className="section-head compact-head">
              <div>
                <p className="eyebrow">Decision evidence</p>
                <h2 id="po-candidates">Suggested purchase order</h2>
              </div>
              <span>{detail.poCandidates.length} feasible match</span>
            </div>
            <div className="candidate-evidence">
              {detail.poCandidates.map((candidate) => (
                <div key={candidate.poNumber}>
                  <strong>{candidate.poNumber}</strong>
                  <span>{candidate.matchedLineCount} invoice line matched</span>
                  <dl>
                    <div>
                      <dt>Remaining value</dt>
                      <dd>${candidate.remainingPoBasisValue}</dd>
                    </div>
                    <div>
                      <dt>Invoice difference</dt>
                      <dd>${candidate.subtotalDifference}</dd>
                    </div>
                  </dl>
                  <div className="candidate-line-evidence">
                    {candidate.lines.map((line) => (
                      <div key={line.poLineId}>
                        <div>
                          <span>Invoice item</span>
                          <strong>
                            {line.invoiceDescription || line.invoiceSku}
                          </strong>
                          <small>
                            {line.invoiceSku || "No SKU"} ·{" "}
                            {line.requestedQuantity} {line.uom} requested
                          </small>
                        </div>
                        <span aria-hidden="true">→</span>
                        <div>
                          <span>PO item</span>
                          <strong>{line.poDescription}</strong>
                          <small>
                            {line.poSku} · ${line.poUnitPrice} each ·{" "}
                            {line.availableReceivedQuantity} received available
                          </small>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {detail.bundleCandidates[0] && (
          <section
            className="surface evidence-panel"
            aria-labelledby="bundle-evidence"
          >
            <div className="section-head compact-head">
              <div>
                <p className="eyebrow">Decision evidence</p>
                <h2 id="bundle-evidence">Proposed bundle components</h2>
              </div>
              <span>PO {detail.invoice?.poNumber}</span>
            </div>
            <p className="match-summary">
              {detail.invoice?.lines[0]?.description || "Invoice bundle"} is
              represented by these purchasable PO items.
            </p>
            <div className="bundle-evidence">
              {detail.bundleCandidates[0].components.map((component) => (
                <div key={component.poLineId}>
                  <strong>{component.description || component.sku}</strong>
                  <span>{component.sku}</span>
                  <span>{component.quantity} EA requested</span>
                  <span>${component.unitPrice ?? "—"} each</span>
                  <span>
                    {component.availableReceivedQuantity ?? "—"} received
                    available
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {detail.invoice && (
          <details className="surface invoice-record">
            <summary>
              <div>
                <p className="eyebrow">Supporting record</p>
                <strong id="normalized">{detail.invoice.vendor}</strong>
                <span>
                  {detail.invoice.invoiceNumber} ·{" "}
                  {detail.invoice.poNumber || "No PO supplied"}
                </span>
              </div>
              <div className="invoice-record-total">
                <span>Invoice total</span>
                <strong>${detail.invoice.total}</strong>
              </div>
              <span className="disclosure-label">View details</span>
            </summary>
            <div className="invoice-record-body">
              <div>
                <h3>Invoice details</h3>
                <dl className="facts compact-facts">
                  <SourceFact
                    label="Vendor"
                    value={detail.invoice.vendor}
                    sourceId={detail.invoice.fieldSources.vendor}
                    evidence={detail.evidence}
                    onViewSource={setPdfPage}
                  />
                  <SourceFact
                    label="Invoice #"
                    value={detail.invoice.invoiceNumber}
                    sourceId={detail.invoice.fieldSources.invoiceNumber}
                    evidence={detail.evidence}
                    onViewSource={setPdfPage}
                  />
                  <SourceFact
                    label="Invoice date"
                    value={formatDateOnly(detail.invoice.invoiceDate)}
                    sourceId={detail.invoice.fieldSources.invoiceDate}
                    evidence={detail.evidence}
                    onViewSource={setPdfPage}
                  />
                  <SourceFact
                    label="PO number"
                    value={detail.invoice.poNumber || "Not supplied"}
                    sourceId={detail.invoice.fieldSources.poNumber}
                    evidence={detail.evidence}
                    onViewSource={setPdfPage}
                  />
                </dl>
              </div>
              <div>
                <h3>Payment summary</h3>
                <ValueComparison invoice={detail.invoice} />
                <div className="validation-summary">
                  <span>
                    <strong>
                      {detail.checks.filter((check) => check.passed).length}
                    </strong>
                    checks passed
                  </span>
                  <span>
                    <strong>{detail.allocations.length}</strong>
                    lines matched
                  </span>
                </div>
              </div>
            </div>
          </details>
        )}

        {detail.allocations.length > 0 && (
          <section className="surface" aria-labelledby="comparison">
            <div className="section-head compact-head match-evidence-head">
              <div>
                <p className="eyebrow">Decision evidence</p>
                <h2 id="comparison">How invoice lines matched</h2>
              </div>
              <span>{matchMethodLabel(detail)}</span>
            </div>
            <p className="match-summary">{matchEvidenceSummary(detail)}</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Invoice line</th>
                    <th>PO item</th>
                    <th>Qty</th>
                    <th>PO unit price</th>
                    <th>PO basis</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.allocations.map((allocation) => (
                    <tr key={allocation.poLineId}>
                      <td>
                        <strong>
                          {detail.invoice?.lines[allocation.invoiceLineIndex]
                            ?.description ?? allocation.sku}
                        </strong>
                      </td>
                      <td>
                        <strong>
                          {allocation.poDescription || allocation.sku}
                        </strong>
                        <span className="table-secondary">
                          {allocation.poNumber} · {allocation.sku}
                        </span>
                      </td>
                      <td>{allocation.quantity}</td>
                      <td>
                        {allocation.poUnitPrice
                          ? `$${allocation.poUnitPrice}`
                          : "—"}
                      </td>
                      <td>${allocation.poBasisAmount}</td>
                      <td>
                        {allocation.availableReceivedQuantity ?? "—"} before ·{" "}
                        {allocation.remainingReceivedQuantity} after
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="surface document-panel" aria-labelledby="document">
          <div className="section-head compact-head">
            <div>
              <p className="eyebrow">Source document</p>
              <h2 id="document">Original PDF</h2>
            </div>
            <span className="status-badge neutral">Stored</span>
          </div>
          <Suspense fallback={<p className="muted">Loading PDF preview...</p>}>
            <PdfPreview
              url={`/api/runs/${detail.runId}/document`}
              filename={detail.filename}
              page={pdfPage}
              onPageChange={setPdfPage}
            />
          </Suspense>
        </section>

        {detail.state !== "PROCESSING" && (
          <ProcessingActivity detail={detail} />
        )}

        {detail.checks.length > 0 && (
          <details className="surface audit-details">
            <summary>
              <span>
                <strong>Control details</strong>
                <small>
                  {detail.checks.filter((check) => check.passed).length} of{" "}
                  {detail.checks.length} checks passed
                </small>
              </span>
              <span aria-hidden="true">⌄</span>
            </summary>
            <div className="audit-details-body">
              <ul className="checks">
                {detail.checks.map((check, index) => (
                  <li key={`${check.code}-${index}`}>
                    <span
                      className={`status-badge ${check.passed ? "ok" : "bad"}`}
                    >
                      {check.passed ? "Pass" : "Fail"}
                    </span>
                    <div>
                      <strong>{formatLabel(check.code)}</strong>
                      <p>{check.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
      </main>
    </ConsoleShell>
  );
}

function ConsoleShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const reset = useMutation({
    mutationFn: resetWorkspace,
    onSuccess: () => {
      queryClient.clear();
      navigate("/");
    },
  });
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <path d="M4 6h16M4 12h10M4 18h16" />
            </svg>
          </span>
          <span className="brand-copy">
            <strong>AP Resolution</strong>
            <small>Invoice review</small>
          </span>
        </Link>
        <nav aria-label="Primary">
          <NavLink to="/" end>
            <span className="nav-icon" aria-hidden="true">
              +
            </span>
            New invoice
          </NavLink>
          <NavLink to="/dashboard">
            <span className="nav-icon" aria-hidden="true">
              ▦
            </span>
            Invoices
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <p>Workspace data is stored on this server.</p>
          <button
            type="button"
            className="reset-workspace"
            aria-label="Reset workspace"
            disabled={reset.isPending}
            onClick={() => {
              if (
                window.confirm(
                  "Reset all runs, uploaded documents, and ledger changes in this workspace?",
                )
              )
                reset.mutate();
            }}
          >
            {reset.isPending ? "Resetting…" : "Reset workspace"}
            <span aria-hidden="true">{reset.isPending ? "…" : "Demo"}</span>
          </button>
          <p>Restore demo invoices and clear activity.</p>
          {reset.error && <span className="error">{reset.error.message}</span>}
        </div>
      </aside>
      <div className="app-content">{children}</div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn" | "bad";
}) {
  return (
    <div className="px-4 py-3">
      <span className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)]">{label}</span>
      <strong className={`mt-1 block text-xl font-semibold tabular-nums ${tone === "warn" ? "text-[var(--warning)]" : tone === "ok" ? "text-[var(--success)]" : ""}`}>{value}</strong>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SourceFact({
  label,
  value,
  sourceId,
  evidence,
  onViewSource,
}: {
  label: string;
  value: string;
  sourceId?: string;
  evidence: SourceRef[];
  onViewSource: (page: number) => void;
}) {
  const source = evidence.find((item) => item.id === sourceId);
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {source && (
          <span className="source-hint">
            {source.page ? `Page ${source.page}` : "Document"}
            {source.confidence !== null &&
              ` · ${Math.round(source.confidence * 100)}% confidence`}
            {source.page && (
              <button
                type="button"
                onClick={() => {
                  onViewSource(source.page!);
                  document
                    .getElementById("document")
                    ?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                View source
              </button>
            )}
          </span>
        )}
      </dd>
    </div>
  );
}

function ValueComparison({ invoice }: { invoice: RunDetail["invoice"] }) {
  if (!invoice) return null;
  const changed =
    invoice.observedSubtotal !== invoice.subtotal ||
    invoice.observedTax !== invoice.tax ||
    invoice.lines.some(
      (line) =>
        line.observedAmount !== line.amount ||
        line.observedUnitPrice !== line.unitPrice,
    );
  if (!changed) {
    return (
      <dl className="facts payment-facts">
        <Fact label="Subtotal" value={`$${invoice.subtotal}`} />
        <Fact label="Tax" value={`$${invoice.tax}`} />
        <Fact label="Total" value={`$${invoice.total}`} />
      </dl>
    );
  }
  return (
    <div className="value-comparison">
      <div className="value-comparison-head">
        <span />
        <strong>Observed</strong>
        <strong>Accounting value</strong>
      </div>
      <div>
        <span>Subtotal</span>
        <span>
          {invoice.observedSubtotal
            ? `$${invoice.observedSubtotal}`
            : "Not stated"}
        </span>
        <strong>${invoice.subtotal}</strong>
      </div>
      <div>
        <span>Tax</span>
        <span>
          {invoice.observedTax ? `$${invoice.observedTax}` : "Included"}
        </span>
        <strong>${invoice.tax}</strong>
      </div>
      <div>
        <span>Total</span>
        <span>${invoice.observedTotal}</span>
        <strong>${invoice.total}</strong>
      </div>
    </div>
  );
}

function PartialInvoiceEvidence({
  preview,
  reasonCode,
}: {
  preview: InvoicePreview;
  reasonCode: string | null;
}) {
  const missing = preview.missingField
    ? formatFieldName(preview.missingField)
    : "Required invoice field";
  const fields = [
    ["vendor", "Vendor", preview.vendor],
    ["invoiceNumber", "Invoice number", preview.invoiceNumber],
    ["invoiceDate", "Invoice date", preview.invoiceDate],
    ["poNumber", "PO number", preview.poNumber],
    ["currency", "Currency", preview.currency],
    ["subtotal", "Subtotal", preview.subtotal],
    ["tax", "Tax", preview.tax],
    ["observedTotal", "Total", preview.total],
  ] as const;
  return (
    <section
      className="surface evidence-panel"
      aria-labelledby="partial-evidence"
    >
      <div className="section-head compact-head">
        <div>
          <p className="eyebrow">Extracted evidence</p>
          <h2 id="partial-evidence">What the system could read</h2>
        </div>
        <span className="status-badge bad">
          {missing}{" "}
          {reasonCode === "MISSING_REQUIRED_FIELD" ? "missing" : "needs review"}
        </span>
      </div>
      <div className="evidence-fact-grid">
        {fields.map(([field, label, value]) => {
          const isMissing = preview.missingField === field;
          return (
            <div key={field} className={isMissing ? "missing" : undefined}>
              <span>{label}</span>
              <strong>
                {value || (isMissing ? "Not found" : "Not stated")}
              </strong>
            </div>
          );
        })}
      </div>
      {preview.lines.length > 0 && (
        <div className="evidence-line-list">
          <span>Extracted line items</span>
          {preview.lines.map((line, index) => (
            <div key={`${line.sku}-${index}`}>
              <strong>
                {line.description || line.sku || `Line ${index + 1}`}
              </strong>
              <span>{line.sku || "No SKU"}</span>
              <span>
                {line.quantity || "—"} {line.uom || ""} ×{" "}
                {line.unitPrice || "—"}
              </span>
              <strong>{line.amount || "—"}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DuplicateEvidence({ match }: { match: DuplicateMatch }) {
  return (
    <section
      className="surface evidence-panel"
      aria-labelledby="duplicate-evidence"
    >
      <div className="section-head compact-head">
        <div>
          <p className="eyebrow">Decision evidence</p>
          <h2 id="duplicate-evidence">Existing ledger invoice</h2>
        </div>
        <span>Posted {formatDate(match.postedAt)}</span>
      </div>
      <div className="evidence-fact-grid duplicate-facts">
        <div>
          <span>Invoice</span>
          <strong>{match.invoiceNumber}</strong>
        </div>
        <div>
          <span>Purchase order</span>
          <strong>{match.poNumber}</strong>
        </div>
        <div>
          <span>Invoice total</span>
          <strong>${match.total}</strong>
        </div>
        <div>
          <span>Ledger reference</span>
          <strong>{match.ledgerId}</strong>
        </div>
      </div>
      <div className="evidence-line-list">
        <span>Previously matched PO items</span>
        {match.allocations.map((allocation) => (
          <div key={allocation.poLineId}>
            <strong>{allocation.description}</strong>
            <span>{allocation.sku}</span>
            <span>
              {allocation.quantity} {allocation.uom} × ${allocation.unitPrice}
            </span>
            <strong>${allocation.poBasisAmount}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatFieldName(field: string) {
  const normalized = field.replace(/^lines\.\d+\./, "");
  return (
    {
      vendor: "Vendor",
      invoiceNumber: "Invoice number",
      invoiceDate: "Invoice date",
      currency: "Currency",
      observedTotal: "Invoice total",
      observedUnitPrice: "Unit price",
      quantity: "Line quantity",
      uom: "Unit of measure",
      identity: "Line item SKU or description",
    }[normalized] ?? formatLabel(normalized)
  );
}

function matchMethodLabel(detail: RunDetail) {
  const method = detail.allocations[0]?.matchType;
  if (method === "BUNDLE_MASTER") return "Trusted bundle definition";
  if (method === "BUNDLE_CONFIRMED") return "Reviewer-confirmed bundle";
  return "Direct PO line match";
}

function matchEvidenceSummary(detail: RunDetail) {
  const first = detail.allocations[0];
  const invoiceItem = first
    ? detail.invoice?.lines[first.invoiceLineIndex]?.description
    : null;
  if (first?.matchType === "BUNDLE_MASTER")
    return `${invoiceItem || "The invoice bundle"} was expanded using ${first.bundleDefinitionId} and matched to ${first.poNumber}.`;
  if (first?.matchType === "BUNDLE_CONFIRMED")
    return `${invoiceItem || "The invoice bundle"} was expanded from the confirmed proposal and matched to ${first.poNumber}.`;
  return `${detail.allocations.length} invoice line${detail.allocations.length === 1 ? "" : "s"} matched to ${first?.poNumber} by SKU, description, and unit of measure.`;
}

function DecisionExplanation({ detail }: { detail: RunDetail }) {
  if (detail.state === "PROCESSING") return null;
  if (detail.state !== "POSTED") {
    const failures = uniqueFailures(detail);
    const failed = failures[0];
    return (
      <section className="decision-explanation review">
        <h3>Why this needs review</h3>
        {failures.length > 1 ? (
          <ul className="issue-list">
            {failures.map((check) => (
              <li key={check.code}>
                <strong>{formatReason(check.code)}</strong>
                <span>{check.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <strong>{formatReason(detail.reasonCode ?? detail.state)}</strong>
            <p>{reasonExplanation(detail)}</p>
          </>
        )}
        {failed?.expected && failed.actual && (
          <dl className="exception-facts">
            <div>
              <dt>Expected</dt>
              <dd>{failed.expected}</dd>
            </div>
            <div>
              <dt>Observed</dt>
              <dd>{failed.actual}</dd>
            </div>
          </dl>
        )}
      </section>
    );
  }
  const poBasis = detail.allocations.reduce(
    (sum, allocation) => sum + Number(allocation.poBasisAmount),
    0,
  );
  const usesBundle = detail.allocations.some(
    (allocation) => allocation.matchType !== "DIRECT",
  );
  return (
    <section className="decision-explanation approved">
      <h3>How it was approved</h3>
      <ul>
        <li>
          <strong>Vendor matched</strong>
          <span>Approved vendor · open PO {detail.invoice?.poNumber}</span>
        </li>
        <li>
          <strong>
            {detail.allocations.length}{" "}
            {usesBundle ? "PO components matched" : "lines matched"}
          </strong>
          <span>
            {usesBundle
              ? "The invoice bundle was expanded into its purchasable PO items."
              : "Invoice items matched PO lines by SKU, description, and UOM."}
          </span>
        </li>
        <li>
          <strong>Amounts and capacity passed</strong>
          <span>
            ${detail.invoice?.subtotal} invoice net · ${poBasis.toFixed(2)} PO
            basis
          </span>
        </li>
      </ul>
    </section>
  );
}

function ProcessingActivity({ detail }: { detail: RunDetail }) {
  const phases = processingPhases(detail);
  if (detail.state === "PROCESSING") {
    const activeIndex = Math.max(
      0,
      phases.findIndex((phase) => phase.status !== "COMPLETED"),
    );
    const active = phases[activeIndex]!;
    return (
      <section className="surface processing-focus" aria-live="polite">
        <div>
          <p className="eyebrow">Processing invoice</p>
          <h2>{active.label}</h2>
          <p>{active.description}</p>
        </div>
        <span>
          Step {activeIndex + 1} of {phases.length}
        </span>
        <div className="processing-progress" aria-hidden="true">
          <span
            style={{ width: `${((activeIndex + 1) / phases.length) * 100}%` }}
          />
        </div>
      </section>
    );
  }
  const visible = phases.filter((phase) => phase.status !== "NOT_STARTED");
  if (!visible.length) return null;
  return (
    <details className="surface activity-log">
      <summary>
        <span>
          <strong>Activity log</strong>
          <small>
            {visible.filter((phase) => phase.status === "COMPLETED").length}{" "}
            {visible.filter((phase) => phase.status === "COMPLETED").length ===
            1
              ? "phase"
              : "phases"}{" "}
            completed
          </small>
        </span>
        <span aria-hidden="true">⌄</span>
      </summary>
      <ol>
        {visible.map((phase) => (
          <li key={phase.label}>
            <span className={`dot ${phase.status.toLowerCase()}`} />
            <div>
              <strong>{phase.label}</strong>
              <span>{phase.description}</span>
            </div>
            <time>{phase.at ? formatTime(phase.at) : "—"}</time>
          </li>
        ))}
      </ol>
    </details>
  );
}

function processingPhases(detail: RunDetail) {
  const definitions = [
    {
      label: "Reading invoice",
      description:
        "Extracting invoice fields and linking them to document values.",
      stages: ["EXTRACTION", "MAPPING"],
    },
    {
      label: "Matching and checking",
      description:
        "Matching the vendor, purchase order, lines, amounts, and receipts.",
      stages: ["NORMALIZATION", "CONTROLS"],
    },
    {
      label: "Finalizing",
      description:
        "Posting the approved accounting effect or preparing a review action.",
      stages: ["POSTING"],
    },
  ];
  return definitions.map((definition) => {
    const events = detail.stages.filter((event) =>
      definition.stages.includes(event.stage),
    );
    const failed = events.findLast((event) => event.status === "FAILED");
    const allCompleted = definition.stages.every((stage) =>
      events.some(
        (event) => event.stage === stage && event.status === "COMPLETED",
      ),
    );
    const latest = events.at(-1);
    return {
      ...definition,
      status: failed
        ? ("FAILED" as const)
        : allCompleted
          ? ("COMPLETED" as const)
          : detail.state !== "PROCESSING" && events.length
            ? ("COMPLETED" as const)
            : events.length
              ? ("ACTIVE" as const)
              : ("NOT_STARTED" as const),
      at: latest?.at,
    };
  });
}

function fixtureLabel(fixtureId: FixtureId) {
  return fixtureId
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function formatLabel(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function formatReason(value: string) {
  return (
    {
      DUPLICATE: "Duplicate invoice",
      RECEIPT_CAPACITY_EXCEEDED: "Receipt quantity insufficient",
      MAPPING_FAILED: "Invoice details could not be read",
      EXTRACTION_FAILED: "Document could not be read",
      MISSING_PO: "PO confirmation required",
      BUNDLE_MAPPING_REQUIRED: "Bundle confirmation required",
      PRICE_MATCH: "Price variance",
      RECEIPT_CAPACITY: "Receipt quantity exceeded",
      ORDERED_CAPACITY: "Ordered quantity exceeded",
      PO_VALUE_CAPACITY: "PO value exceeded",
      SUBTOTAL_MATCH: "Subtotal mismatch",
      TOTAL_MATCH: "Total mismatch",
    }[value] ?? formatLabel(value)
  );
}

function describeOutcome(detail: RunDetail) {
  if (detail.state === "POSTED")
    return {
      title: "Approved and posted",
      description:
        "The invoice, purchase order, receipts, and accounting controls all passed.",
      tone: "ok",
      icon: "✓",
    };
  if (detail.state === "PROCESSING")
    return {
      title: "Processing invoice",
      description:
        "Reading the document and validating it against purchasing records.",
      tone: "neutral",
      icon: "…",
    };
  if (detail.state.startsWith("AWAITING"))
    return {
      title: "Confirmation required",
      description: reasonExplanation(detail),
      tone: "warn",
      icon: "!",
    };
  const failures = uniqueFailures(detail);
  return {
    title:
      failures.length > 1
        ? `${failures.length} issues need attention`
        : "Needs review",
    description:
      failures.length > 1
        ? failures.map((check) => formatReason(check.code)).join(" · ")
        : formatReason(detail.reasonCode ?? detail.state),
    tone: "bad",
    icon: "!",
  };
}

function uniqueFailures(detail: RunDetail) {
  return detail.checks
    .filter((check) => !check.passed)
    .filter(
      (check, index, failures) =>
        failures.findIndex((candidate) => candidate.code === check.code) ===
        index,
    );
}

function reasonExplanation(detail: RunDetail) {
  switch (detail.reasonCode) {
    case "DUPLICATE":
      return `Invoice ${detail.invoice?.invoiceNumber ?? "number"} is already posted for this vendor. Nothing was posted again.`;
    case "RECEIPT_CAPACITY_EXCEEDED":
      return "The invoice quantity is greater than the remaining received quantity on the purchase order. Nothing was posted.";
    case "MISSING_PO":
      return "No purchase order was found on the invoice. Confirm the stored candidate before posting.";
    case "BUNDLE_MAPPING_REQUIRED":
      return "The invoice contains an unknown bundle. Confirm the proposed component decomposition before posting.";
    case "MAPPING_FAILED":
      return "Required invoice fields could not be linked reliably to the extracted document values.";
    case "EXTRACTION_FAILED":
      return "The document could not be read reliably. Check the PDF quality and try again.";
    default:
      return (
        detail.nextAction ?? "Review the failed control before continuing."
      );
  }
}

function stateTone(state: string): "neutral" | "ok" | "warn" | "bad" {
  if (state === "POSTED") return "ok";
  if (state === "PROCESSING") return "neutral";
  if (state.startsWith("AWAITING")) return "warn";
  return "bad";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDateOnly(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(`${value}T00:00:00`),
  );
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function StatusPage({ children }: { children: React.ReactNode }) {
  return (
    <ConsoleShell>
      <main className="console-main">
        <section className="surface status-page">
          <p>{children}</p>
          <Link className="button-link" to="/">
            Back to console
          </Link>
        </section>
      </main>
    </ConsoleShell>
  );
}
