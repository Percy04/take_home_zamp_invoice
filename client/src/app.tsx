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
