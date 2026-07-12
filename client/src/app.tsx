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
  type FixtureId,
} from "./api";

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
                    <th>Status</th>
                    <th>Outcome</th>
                    <th>Issue</th>
                    <th>Updated</th>
                    <th className="sr-only">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.items.map((run) => (
                    <tr key={run.runId}>
                      <td className="invoice-cell">
                        <Link to={`/runs/${run.runId}`}>{run.filename}</Link>
                        <span>{run.runId.slice(0, 8)}</span>
                      </td>
                      <td>
                        <span
                          className={`status-badge ${stateTone(run.state)}`}
                        >
                          {formatLabel(run.state)}
                        </span>
                      </td>
                      <td>
                        {run.decision ? (
                          formatLabel(run.decision)
                        ) : (
                          <span className="not-available">—</span>
                        )}
                      </td>
                      <td>
                        {run.reasonCode ? (
                          formatLabel(run.reasonCode)
                        ) : (
                          <span className="not-available">—</span>
                        )}
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

  useEffect(() => {
    if (run.data?.state !== "PROCESSING" || processStarted.current) return;
    processStarted.current = true;
    void processRun(runId)
      .then((result) => queryClient.setQueryData(["run", runId], result))
      .catch(() => {
        processStarted.current = false;
        void refetchRun();
      });
  }, [run.data?.state, refetchRun, runId]);

  if (run.isPending) return <StatusPage>Loading run...</StatusPage>;
  if (run.error || !run.data)
    return <StatusPage>{run.error?.message ?? "Run not found."}</StatusPage>;
  const detail = run.data;
  const isPosted = detail.state === "POSTED";

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
          className="decision-strip run-summary-bar"
          aria-label="Run decision"
        >
          <Metric
            label="Decision"
            value={formatLabel(detail.decision ?? "PROCESSING")}
            tone={isPosted ? "ok" : detail.reasonCode ? "bad" : "warn"}
          />
          <Metric label="State" value={formatLabel(detail.state)} />
          <Metric
            label="Execution"
            value={formatLabel(detail.execution ?? "PENDING")}
          />
          <Metric label="Ledger" value={detail.ledgerId ?? "No mutation"} />
        </section>

        {detail.reasonCode && (
          <section className="surface alert" aria-label="Review reason">
            <strong>{detail.reasonCode}</strong>
            <p>{detail.nextAction}</p>
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
                    {isPosted ? "Ready" : formatLabel(detail.state)}
                  </span>
                </div>
                <div
                  className="review-tabs"
                  role="tablist"
                  aria-label="Invoice details"
                >
                  <button type="button" role="tab" aria-selected="true">
                    Overview
                  </button>
                  <span role="tab" aria-selected="false">
                    Line items
                  </span>
                  <span role="tab" aria-selected="false">
                    Audit trail
                  </span>
                </div>
                <h3 className="fact-group-title">Invoice details</h3>
                <dl className="facts">
                  <Fact label="Vendor" value={detail.invoice.vendor} />
                  <Fact
                    label="Invoice #"
                    value={detail.invoice.invoiceNumber}
                  />
                </dl>
                <h3 className="fact-group-title">Purchase order match</h3>
                <dl className="facts">
                  <Fact label="PO number" value={detail.invoice.poNumber} />
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
                <dl className="facts payment-facts">
                  <Fact
                    label="Subtotal"
                    value={`$${detail.invoice.subtotal}`}
                  />
                  <Fact label="Tax" value={`$${detail.invoice.tax}`} />
                  <Fact label="Total" value={`$${detail.invoice.total}`} />
                </dl>
                <div className="validation-summary">
                  <span>
                    <strong>
                      {detail.checks.filter((check) => check.passed).length}
                    </strong>
                    checks passed
                  </span>
                  <span>
                    <strong>{detail.evidence.length}</strong>
                    evidence fields
                  </span>
                </div>
              </section>
            )}

            <section
              className="surface pipeline-panel"
              aria-labelledby="stages"
            >
              <div className="section-head">
                <div>
                  <p className="eyebrow">Workflow</p>
                  <h2 id="stages">Processing activity</h2>
                </div>
              </div>
              <ol className="timeline">
                {detail.stages.map((stage, index) => (
                  <li key={`${stage.stage}-${index}`}>
                    <span className={`dot ${stage.status.toLowerCase()}`} />
                    <strong>{formatLabel(stage.stage)}</strong>
                    <span>{formatLabel(stage.status)}</span>
                  </li>
                ))}
              </ol>
            </section>
          </aside>
        </div>

        {detail.allocations.length > 0 && (
          <section className="surface" aria-labelledby="comparison">
            <div className="section-head">
              <div>
                <p className="eyebrow">Accounting effect</p>
                <h2 id="comparison">Invoice to PO comparison</h2>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Quantity</th>
                    <th>Invoice net</th>
                    <th>PO basis</th>
                    <th>Received left</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.allocations.map((allocation) => (
                    <tr key={allocation.poLineId}>
                      <td>{allocation.sku}</td>
                      <td>{allocation.quantity}</td>
                      <td>${allocation.actualNetAmount}</td>
                      <td>${allocation.poBasisAmount}</td>
                      <td>{allocation.remainingReceivedQuantity}</td>
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

        <div className="run-grid bottom-grid">
          {detail.checks.length > 0 && (
            <section className="surface" aria-labelledby="controls">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Controls</p>
                  <h2 id="controls">Check results</h2>
                </div>
              </div>
              <ul className="checks">
                {detail.checks.map((check, index) => (
                  <li key={`${check.code}-${index}`}>
                    <span
                      className={`status-badge ${check.passed ? "ok" : "bad"}`}
                    >
                      {check.passed ? "Pass" : "Fail"}
                    </span>
                    <div>
                      <strong>{check.code}</strong>
                      <p>{check.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail.evidence.length > 0 && (
            <section className="surface" aria-labelledby="evidence">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Provider evidence</p>
                  <h2 id="evidence">Extracted fields</h2>
                </div>
              </div>
              <ul className="evidence">
                {detail.evidence
                  .filter(
                    (source) =>
                      source.label !== "OCR line" ||
                      source.content.length < 160,
                  )
                  .slice(0, 18)
                  .map((source) => (
                    <li key={source.id}>
                      <strong>{source.label}</strong>
                      <p>{source.content}</p>
                      <span>
                        Page {source.page ?? "-"} -{" "}
                        {source.confidence === null
                          ? "confidence -"
                          : `${Math.round(source.confidence * 100)}%`}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </div>
      </main>
    </ConsoleShell>
  );
}

function ConsoleShell({ children }: { children: React.ReactNode }) {
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
        <p className="sidebar-note">Accounts payable workspace</p>
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
