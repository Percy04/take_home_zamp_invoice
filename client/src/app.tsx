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
  resetWorkspace,
  type FixtureId,
} from "./api";
import type { RunDetail, SourceRef } from "../../shared/contracts";

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
  const [file, setFile] = useState<File>();
  const [fileError, setFileError] = useState<string>();
  const create = useMutation({
    mutationFn: createRun,
    onSuccess: (run) => navigate(`/runs/${run.runId}`),
  });

  return (
    <ConsoleShell>
      <main className="console-main intake-layout" aria-labelledby="page-title">
        <div className="page-heading compact">
          <div>
            <p className="eyebrow">Invoice intake</p>
            <h1 id="page-title">Upload an invoice</h1>
            <p className="summary">
              Add a PDF to extract its details, match it to a purchase order,
              and run accounting controls.
            </p>
          </div>
        </div>

        <div className="workspace-grid intake-grid">
          <section className="surface upload-surface" aria-labelledby="upload">
            <div>
              <h2 id="upload">Invoice document</h2>
              <p className="muted">PDF files up to 10 MiB.</p>
            </div>

            <label className="file-control upload-dropzone">
              <span className="upload-icon" aria-hidden="true">
                ↑
              </span>
              <strong>{file ? file.name : "Choose an invoice PDF"}</strong>
              <span>Click to browse from your device</span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  if (
                    selected &&
                    selected.type !== "application/pdf" &&
                    !selected.name.toLowerCase().endsWith(".pdf")
                  ) {
                    setFile(undefined);
                    setFileError("Choose a PDF file.");
                  } else if (selected && selected.size > 10 * 1024 * 1024) {
                    setFile(undefined);
                    setFileError("The PDF must be 10 MiB or smaller.");
                  } else {
                    setFile(selected);
                    setFileError(undefined);
                  }
                }}
              />
            </label>

            <div className="action-row">
              <button
                disabled={!file || create.isPending}
                onClick={() => file && create.mutate(file)}
              >
                {create.isPending
                  ? "Processing invoice..."
                  : "Upload and process"}
              </button>
            </div>
            <div className="privacy-note" role="note">
              <strong>How your document is processed</strong>
              <p>
                The PDF is sent to Azure Document Intelligence. Only the
                extracted invoice evidence is sent to the configured AI mapping
                provider. The uploaded document and result are stored in this
                workspace.
              </p>
            </div>
            {fileError && <p className="error">{fileError}</p>}
            {create.error && <p className="error">{create.error.message}</p>}
          </section>

          <aside className="intake-side">
            <section className="surface" aria-labelledby="workflow">
              <p className="eyebrow">Automated workflow</p>
              <h2 id="workflow">What happens next</h2>
              <ol className="workflow-list">
                <li>
                  <span>1</span>
                  <div>
                    <strong>Extract</strong>
                    <p>Read invoice fields and line items.</p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>Match</strong>
                    <p>Compare against the purchase order.</p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>Review</strong>
                    <p>Post automatically or flag exceptions.</p>
                  </div>
                </li>
              </ol>
            </section>

            <section
              className="surface demo-panel"
              aria-labelledby="demo-invoices"
            >
              <div className="section-head">
                <div>
                  <p className="eyebrow">Demo workspace</p>
                  <h2 id="demo-invoices">Try a sample invoice</h2>
                </div>
              </div>
              <div className="fixture-grid" aria-label="Fixture runs">
                {fixtureIds.map((fixtureId) => (
                  <button
                    key={fixtureId}
                    className="secondary"
                    disabled={create.isPending}
                    onClick={() => create.mutate(fixtureId)}
                  >
                    {fixtureLabel(fixtureId)}
                  </button>
                ))}
              </div>
            </section>
          </aside>
        </div>
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
      <main
        className="console-main dashboard-layout"
        aria-labelledby="dashboard-title"
      >
        <div className="page-heading compact">
          <div>
            <p className="eyebrow">Accounts payable</p>
            <h1 id="dashboard-title">Invoices</h1>
            <p className="summary">
              Review processing outcomes and resolve invoices that need
              attention.
            </p>
          </div>
        </div>

        {runs.data && (
          <section
            className="metric-grid dashboard-metrics"
            aria-label="Dashboard metrics"
          >
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

        <section
          className="surface dashboard-table"
          aria-labelledby="recent-runs-title"
        >
          <div className="table-toolbar">
            <div>
              <h2 id="recent-runs-title">Invoice activity</h2>
              <p className="muted">
                {runs.data
                  ? `${runs.data.items.length} ${runs.data.items.length === 1 ? "invoice" : "invoices"}`
                  : "Loading invoice history..."}
              </p>
            </div>
            <label>
              <span>Status</span>
              <select
                value={state}
                onChange={(event) => {
                  const next = new URLSearchParams();
                  if (event.target.value) next.set("state", event.target.value);
                  setSearch(next);
                }}
              >
                <option value="">All states</option>
                <option value="POSTED">Posted</option>
                <option value="NEEDS_REVIEW">Needs review</option>
                <option value="AWAITING_PO_CONFIRMATION">Awaiting PO</option>
                <option value="AWAITING_BUNDLE_CONFIRMATION">
                  Awaiting bundle
                </option>
                <option value="PROCESSING">Processing</option>
              </select>
            </label>
          </div>
          {runs.isPending && (
            <p className="table-message muted">Loading runs...</p>
          )}
          {runs.error && <p className="error">{runs.error.message}</p>}
          {runs.data?.items.length === 0 && (
            <div className="empty-state">
              <strong>No matching runs</strong>
              <p className="muted">
                Try another status or process a new invoice.
              </p>
            </div>
          )}
          {runs.data && runs.data.items.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th className="sr-only">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.items.map((run) => (
                    <tr key={run.runId}>
                      <td className="invoice-cell">
                        <Link to={`/runs/${run.runId}`}>
                          {run.invoiceNumber ?? run.filename}
                        </Link>
                        <span>{run.vendor ?? run.filename}</span>
                      </td>
                      <td className="amount-cell">
                        {run.total ? `$${run.total}` : "—"}
                      </td>
                      <td className="status-cell">
                        <span
                          className={`status-badge ${stateTone(run.state)}`}
                        >
                          {formatLabel(run.state)}
                        </span>
                        {run.reasonCode ? (
                          <span>{formatReason(run.reasonCode)}</span>
                        ) : null}
                      </td>
                      <td className="date-cell">{formatDate(run.updatedAt)}</td>
                      <td className="row-action">
                        <Link
                          to={`/runs/${run.runId}`}
                          aria-label={`Open ${run.filename}`}
                        >
                          <span aria-hidden="true">→</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {runs.data && (cursor || runs.data.nextCursor) && (
            <div className="pagination-row">
              <button
                className="secondary"
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
                className="secondary"
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
  const [pdfPage, setPdfPage] = useState(1);
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
  const bundleConfirmation = useMutation({
    mutationFn: (candidateId: string) => confirmBundle(runId, candidateId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  useEffect(() => setPdfPage(1), [runId]);

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
          <span className="outcome-icon" aria-hidden="true">
            {outcome.icon}
          </span>
          <div>
            <p className="eyebrow">Invoice result</p>
            <h2 id="outcome-title">{outcome.title}</h2>
            <p>{outcome.description}</p>
            {detail.nextAction && !isPosted && (
              <p className="outcome-action">
                <strong>Next step:</strong> {detail.nextAction}
              </p>
            )}
          </div>
          {detail.ledgerId && (
            <div className="ledger-reference">
              <span>Ledger reference</span>
              <strong>{detail.ledgerId}</strong>
            </div>
          )}
        </section>

        {processError && (
          <section className="surface processing-error" role="alert">
            <div>
              <strong>Processing stopped</strong>
              <p>{processError}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                processStarted.current = false;
                setProcessError(undefined);
              }}
            >
              Retry processing
            </button>
          </section>
        )}

        {detail.state === "AWAITING_PO_CONFIRMATION" && detail.candidatePo && (
          <section
            className="surface confirmation-panel"
            aria-label="PO confirmation"
          >
            <div>
              <p className="eyebrow">Reviewer action</p>
              <h2>Confirm PO {detail.candidatePo}</h2>
            </div>
            <button
              disabled={poConfirmation.isPending}
              onClick={() => poConfirmation.mutate(detail.candidatePo!)}
            >
              {poConfirmation.isPending ? "Confirming..." : "Confirm PO"}
            </button>
            {poConfirmation.error && (
              <p className="error">{poConfirmation.error.message}</p>
            )}
          </section>
        )}

        {detail.state === "AWAITING_BUNDLE_CONFIRMATION" &&
          detail.bundleCandidates[0] && (
            <section
              className="surface confirmation-panel"
              aria-label="Bundle confirmation"
            >
              <div>
                <p className="eyebrow">Reviewer action</p>
                <h2>Confirm bundle decomposition</h2>
                <p className="muted">
                  {detail.bundleCandidates[0].components
                    .map(
                      (component) => `${component.quantity} ${component.sku}`,
                    )
                    .join(", ")}
                </p>
              </div>
              <button
                disabled={bundleConfirmation.isPending}
                onClick={() =>
                  bundleConfirmation.mutate(detail.bundleCandidates[0]!.id)
                }
              >
                {bundleConfirmation.isPending
                  ? "Confirming..."
                  : "Confirm bundle"}
              </button>
              {bundleConfirmation.error && (
                <p className="error">{bundleConfirmation.error.message}</p>
              )}
            </section>
          )}

        <div className="run-grid review-workspace">
          <section
            className="surface document-panel"
            aria-labelledby="document"
          >
            <div className="section-head">
              <div>
                <p className="eyebrow">Source document</p>
                <h2 id="document">Original PDF</h2>
              </div>
              <span className="status-badge neutral">Stored</span>
            </div>
            <Suspense
              fallback={<p className="muted">Loading PDF preview...</p>}
            >
              <PdfPreview
                url={`/api/runs/${detail.runId}/document`}
                filename={detail.filename}
                page={pdfPage}
                onPageChange={setPdfPage}
              />
            </Suspense>
          </section>

          <aside className="side-stack">
            {detail.invoice && (
              <section
                className="surface review-panel"
                aria-labelledby="normalized"
              >
                <div className="review-panel-head">
                  <div>
                    <p className="eyebrow">Invoice review</p>
                    <h2 id="normalized">{detail.invoice.vendor}</h2>
                    <strong className="invoice-total">
                      ${detail.invoice.total}
                    </strong>
                  </div>
                  <span className={`status-badge ${stateTone(detail.state)}`}>
                    {isPosted ? "Approved" : formatLabel(detail.state)}
                  </span>
                </div>
                <h3 className="fact-group-title">Invoice details</h3>
                <dl className="facts">
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
                </dl>
                <h3 className="fact-group-title">Purchase order match</h3>
                <dl className="facts">
                  <SourceFact
                    label="PO number"
                    value={detail.invoice.poNumber}
                    sourceId={detail.invoice.fieldSources.poNumber}
                    evidence={detail.evidence}
                    onViewSource={setPdfPage}
                  />
                  <Fact
                    label="Match status"
                    value={
                      detail.allocations.length > 0
                        ? `${detail.allocations.length} line items matched`
                        : "Pending validation"
                    }
                  />
                </dl>
                <h3 className="fact-group-title">Payment summary</h3>
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
                <DecisionExplanation detail={detail} />
              </section>
            )}

            <ProcessingActivity detail={detail} />
          </aside>
        </div>

        {detail.allocations.length > 0 && (
          <section className="surface" aria-labelledby="comparison">
            <div className="section-head">
              <div>
                <p className="eyebrow">Matching</p>
                <h2 id="comparison">How invoice lines matched</h2>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Invoice line</th>
                    <th>Matched PO line</th>
                    <th>Qty</th>
                    <th>Invoice net</th>
                    <th>PO basis</th>
                    <th>Received left</th>
                    <th>Result</th>
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
                        {allocation.poNumber} · {allocation.sku}
                      </td>
                      <td>{allocation.quantity}</td>
                      <td>${allocation.actualNetAmount}</td>
                      <td>${allocation.poBasisAmount}</td>
                      <td>{allocation.remainingReceivedQuantity}</td>
                      <td>
                        <span className="status-badge ok">Matched</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {detail.poCandidates.length > 0 && (
          <section className="surface" aria-labelledby="po-candidates">
            <div className="section-head">
              <div>
                <p className="eyebrow">Reviewer evidence</p>
                <h2 id="po-candidates">PO candidates</h2>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>PO</th>
                    <th>Lines matched</th>
                    <th>Remaining basis</th>
                    <th>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.poCandidates.map((candidate) => (
                    <tr key={candidate.poNumber}>
                      <td>{candidate.poNumber}</td>
                      <td>
                        {candidate.matchedLineCount}
                        {candidate.allLinesResolvable ? " (all)" : ""}
                      </td>
                      <td>${candidate.remainingPoBasisValue}</td>
                      <td>${candidate.subtotalDifference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
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
            AP
          </span>
          <span>AP Resolution</span>
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
          </button>
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
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
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

function DecisionExplanation({ detail }: { detail: RunDetail }) {
  if (detail.state === "PROCESSING") return null;
  if (detail.state !== "POSTED") {
    const failed = detail.checks.find((check) => !check.passed);
    return (
      <section className="decision-explanation review">
        <h3>Why this needs review</h3>
        <strong>{formatReason(detail.reasonCode ?? detail.state)}</strong>
        <p>{reasonExplanation(detail)}</p>
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
  return (
    <section className="decision-explanation approved">
      <h3>How it was approved</h3>
      <ul>
        <li>
          <strong>Vendor matched</strong>
          <span>An approved vendor record matched exactly.</span>
        </li>
        <li>
          <strong>Purchase order matched</strong>
          <span>
            {detail.invoice?.poNumber} is open and belongs to this vendor.
          </span>
        </li>
        <li>
          <strong>{detail.allocations.length} lines matched</strong>
          <span>
            Invoice items matched PO lines by SKU, description, and UOM.
          </span>
        </li>
        <li>
          <strong>Amounts reconciled</strong>
          <span>
            Invoice net ${detail.invoice?.subtotal} matches PO basis $
            {poBasis.toFixed(2)}.
          </span>
        </li>
        <li>
          <strong>Receipt capacity passed</strong>
          <span>
            Allocated quantities are within ordered and received capacity.
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
            phases completed
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
      description: formatReason(detail.reasonCode ?? detail.state),
      tone: "warn",
      icon: "!",
    };
  return {
    title: "Needs review",
    description: formatReason(detail.reasonCode ?? detail.state),
    tone: "bad",
    icon: "!",
  };
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
