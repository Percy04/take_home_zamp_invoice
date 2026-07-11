import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { createRun, getRun, processRun } from "./api";

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<InvoicePage />} />
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
    <main>
      <section aria-labelledby="page-title">
        <p className="eyebrow">AP Resolution Agent</p>
        <h1 id="page-title">Invoice decisions you can trace.</h1>
        <p className="summary">
          Upload a synthetic invoice to compare it with purchase records and see every control
          behind the result.
        </p>
        <div className="actions">
          <label className="file-control">
            <span>Invoice PDF</span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => setFile(event.target.files?.[0])}
            />
          </label>
          <button disabled={!file || create.isPending} onClick={() => file && create.mutate(file)}>
            {create.isPending ? "Uploading…" : "Process PDF"}
          </button>
          <button
            className="secondary"
            disabled={create.isPending}
            onClick={() => create.mutate("happy")}
          >
            Try happy-path fixture
          </button>
        </div>
        {create.error && <p className="error">{create.error.message}</p>}
        <p className="privacy" role="note">
          Use synthetic data only. In live mode the PDF goes to Azure and extracted evidence goes
          to OpenAI; provider credentials remain on the server.
        </p>
      </section>
    </main>
  );
}

function RunPage() {
  const { runId = "" } = useParams();
  const processStarted = useRef(false);
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRun(runId),
    refetchInterval: (query) => (query.state.data?.state === "PROCESSING" ? 500 : false),
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

  if (run.isPending) return <StatusPage>Loading run…</StatusPage>;
  if (run.error || !run.data) return <StatusPage>{run.error?.message ?? "Run not found."}</StatusPage>;
  const detail = run.data;

  return (
    <main className="run-page">
      <header>
        <div>
          <p className="eyebrow">Invoice run</p>
          <h1>{detail.invoice?.invoiceNumber ?? detail.filename}</h1>
        </div>
        <Link to="/">New invoice</Link>
      </header>

      <section className={`decision ${detail.state === "POSTED" ? "success" : "processing"}`}>
        <p className="eyebrow">Decision</p>
        <h2>{detail.decision ?? "Processing evidence…"}</h2>
        <p>{detail.ledgerId ? `Posted once as ${detail.ledgerId}` : "The server is working through the persisted stages."}</p>
      </section>

      <section>
        <h2>Processing stages</h2>
        <ol className="timeline">
          {detail.stages.map((stage, index) => (
            <li key={`${stage.stage}-${index}`}>
              <strong>{stage.stage}</strong>
              <span>{stage.status}</span>
            </li>
          ))}
        </ol>
      </section>

      {detail.invoice && (
        <section>
          <h2>Normalized invoice</h2>
          <dl className="facts">
            <div><dt>Vendor</dt><dd>{detail.invoice.vendor}</dd></div>
            <div><dt>PO</dt><dd>{detail.invoice.poNumber}</dd></div>
            <div><dt>Subtotal</dt><dd>${detail.invoice.subtotal}</dd></div>
            <div><dt>Tax</dt><dd>${detail.invoice.tax}</dd></div>
            <div><dt>Total</dt><dd>${detail.invoice.total}</dd></div>
          </dl>
        </section>
      )}

      {detail.allocations.length > 0 && (
        <section>
          <h2>Invoice to PO comparison</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>SKU</th><th>Quantity</th><th>Invoice net</th><th>PO basis</th><th>Received left</th></tr></thead>
              <tbody>
                {detail.allocations.map((allocation) => (
                  <tr key={allocation.poLineId}>
                    <td>{allocation.sku}</td><td>{allocation.quantity}</td>
                    <td>${allocation.actualNetAmount}</td><td>${allocation.poBasisAmount}</td>
                    <td>{allocation.remainingReceivedQuantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {detail.checks.length > 0 && (
        <section>
          <h2>Controls</h2>
          <ul className="checks">
            {detail.checks.map((check, index) => (
              <li key={`${check.code}-${index}`}><span aria-hidden="true">✓</span><div><strong>{check.code}</strong><p>{check.detail}</p></div></li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function StatusPage({ children }: { children: React.ReactNode }) {
  return <main><section><p>{children}</p><Link to="/">Back to upload</Link></section></main>;
}
