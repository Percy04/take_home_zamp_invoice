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
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import { createRun, getRun, processRun } from "./api";

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<InvoicePage />} />
          <Route path="/dashboard" element={<InvoicePage />} />
          <Route path="/runs/:runId" element={<RunPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function InvoicePage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File>();
  const create = useMutation({
    mutationFn: createRun,
    onSuccess: (run) => navigate(`/runs/${run.runId}`),
  });

  return (
    <ConsoleShell>
      <main className="console-main" aria-labelledby="page-title">
        <div className="page-heading">
          <div>
            <p className="eyebrow">AP Resolution Agent</p>
            <h1 id="page-title">AP operations console</h1>
            <p className="summary">
              Process a synthetic invoice, review the control trail, and confirm
              whether the demo ledger changed.
            </p>
          </div>
          <div className="mode-panel" role="note">
            <span className="label">Current scope</span>
            <strong>Phase 1 happy-path slice</strong>
            <p>
              Use synthetic data only. In live mode the PDF goes to Azure and
              extracted evidence goes to Gemini.
            </p>
          </div>
        </div>

        <div className="metric-grid" aria-label="Implementation status">
          <Metric label="Decision engine" value="Direct PO" />
          <Metric label="Persistence" value="SQLite" />
          <Metric label="Posting" value="Once per run" />
        </div>

        <div className="workspace-grid">
          <section className="surface upload-surface" aria-labelledby="upload">
            <div>
              <p className="eyebrow">New run</p>
              <h2 id="upload">Invoice intake</h2>
              <p className="muted">
                Upload a PDF or run the committed happy-path fixture.
              </p>
            </div>

            <label className="file-control">
              <span>Invoice PDF</span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => setFile(event.target.files?.[0])}
              />
            </label>

            <div className="action-row">
              <button
                disabled={!file || create.isPending}
                onClick={() => file && create.mutate(file)}
              >
                {create.isPending ? "Uploading..." : "Process PDF"}
              </button>
              <button
                className="secondary"
                disabled={create.isPending}
                onClick={() => create.mutate("happy")}
              >
                Run happy fixture
              </button>
            </div>

            {file && <p className="muted selected-file">Selected: {file.name}</p>}
            {create.error && <p className="error">{create.error.message}</p>}
          </section>

          <section className="surface" aria-labelledby="capabilities">
            <div className="section-head">
              <div>
                <p className="eyebrow">Available now</p>
                <h2 id="capabilities">Run workflow</h2>
              </div>
              <span className="status-badge neutral">Phase 1</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Status</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Happy fixture</td>
                  <td>
                    <span className="status-badge ok">Ready</span>
                  </td>
                  <td>Posts when controls pass.</td>
                </tr>
                <tr>
                  <td>Live providers</td>
                  <td>
                    <span className="status-badge warn">Config needed</span>
                  </td>
                  <td>Requires Azure and Gemini env vars.</td>
                </tr>
                <tr>
                  <td>Other fixtures</td>
                  <td>
                    <span className="status-badge neutral">Next phase</span>
                  </td>
                  <td>Controls are not fully ported yet.</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
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
        <div className="page-heading compact">
          <div>
            <p className="eyebrow">Invoice run</p>
            <h1>{detail.invoice?.invoiceNumber ?? detail.filename}</h1>
            <p className="summary">
              {detail.filename} - {detail.runId}
            </p>
          </div>
          <Link className="button-link" to="/">
            New invoice
          </Link>
        </div>

        <section className="decision-strip" aria-label="Run decision">
          <Metric
            label="Decision"
            value={detail.decision ?? "Processing"}
            tone={isPosted ? "ok" : detail.reasonCode ? "bad" : "warn"}
          />
          <Metric label="State" value={detail.state} />
          <Metric label="Execution" value={detail.execution ?? "Pending"} />
          <Metric label="Ledger" value={detail.ledgerId ?? "No mutation"} />
        </section>

        {detail.reasonCode && (
          <section className="surface alert" aria-label="Review reason">
            <strong>{detail.reasonCode}</strong>
            <p>{detail.nextAction}</p>
          </section>
        )}

        <div className="run-grid">
          <section className="surface document-panel" aria-labelledby="document">
            <div className="section-head">
              <div>
                <p className="eyebrow">Source document</p>
                <h2 id="document">Original PDF</h2>
              </div>
              <span className="status-badge neutral">Stored</span>
            </div>
            <iframe
              className="pdf-preview"
              src={`/api/runs/${detail.runId}/document`}
              title={`Original invoice: ${detail.filename}`}
            />
          </section>

          <aside className="side-stack">
            <section className="surface" aria-labelledby="stages">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Pipeline</p>
                  <h2 id="stages">Stages</h2>
                </div>
              </div>
              <ol className="timeline">
                {detail.stages.map((stage, index) => (
                  <li key={`${stage.stage}-${index}`}>
                    <span className={`dot ${stage.status.toLowerCase()}`} />
                    <strong>{stage.stage}</strong>
                    <span>{stage.status}</span>
                  </li>
                ))}
              </ol>
            </section>

            {detail.invoice && (
              <section className="surface" aria-labelledby="normalized">
                <div className="section-head">
                  <div>
                    <p className="eyebrow">Invoice</p>
                    <h2 id="normalized">Normalized values</h2>
                  </div>
                </div>
                <dl className="facts">
                  <Fact label="Vendor" value={detail.invoice.vendor} />
                  <Fact label="PO" value={detail.invoice.poNumber} />
                  <Fact label="Subtotal" value={`$${detail.invoice.subtotal}`} />
                  <Fact label="Tax" value={`$${detail.invoice.tax}`} />
                  <Fact label="Total" value={`$${detail.invoice.total}`} />
                </dl>
              </section>
            )}
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
                      source.id.startsWith("field.") ||
                      source.id.startsWith("item."),
                  )
                  .slice(0, 12)
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
      <header className="app-topbar">
        <Link className="brand" to="/">
          AP Resolution Agent
        </Link>
        <nav aria-label="Primary">
          <Link to="/">Console</Link>
          <Link to="/dashboard">Dashboard</Link>
        </nav>
      </header>
      {children}
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
