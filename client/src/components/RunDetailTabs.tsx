import { useState } from "react";
import { dateLong, dateTime, money, qty } from "@/lib/format";
import type { Run } from "@/lib/types";

type Tab = "invoice" | "purchase-order" | "matching" | "controls";

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "invoice", label: "Invoice" },
  { id: "purchase-order", label: "Purchase order" },
  { id: "matching", label: "Matching" },
  { id: "controls", label: "Controls & history" },
];

export function RunDetailTabs({ run }: { run: Run }) {
  const [active, setActive] = useState<Tab>("invoice");

  return (
    <section className="panel overflow-hidden [overflow-anchor:none]" aria-label="Invoice details">
      <div
        role="tablist"
        aria-label="Run detail views"
        className="flex overflow-x-auto border-b border-border"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active === tab.id}
            onClick={() => setActive(tab.id)}
            className={`shrink-0 border-b-2 px-4 py-3 text-[12.5px] font-medium transition-colors ${
              active === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="p-3 md:p-4">
        <div
          role="tabpanel"
          aria-label={tabs.find((tab) => tab.id === active)?.label}
          className="min-w-0"
        >
          {active === "invoice" && <InvoiceTab run={run} />}
          {active === "purchase-order" && <PurchaseOrderTab run={run} />}
          {active === "matching" && <MatchingTab run={run} />}
          {active === "controls" && <ControlsHistoryTab run={run} />}
        </div>
      </div>
    </section>
  );
}

function InvoiceTab({ run }: { run: Run }) {
  const invoice = run.invoice;
  if (!invoice)
    return <Empty text="Invoice fields will appear once document reading is complete." />;

  const details: Array<[string, React.ReactNode]> = [
    ["Vendor", invoice.vendor],
    ["Invoice number", invoice.invoiceNumber],
    [
      "Invoice date",
      invoice.invoiceDate ? (
        dateLong(invoice.invoiceDate)
      ) : (
        <span className="font-sans text-destructive">! could not be read</span>
      ),
    ],
    ["PO number", invoice.poNumber ?? "Not found"],
    ["Currency", invoice.currency],
    ["Subtotal", money(invoice.normalizedSubtotal, invoice.currency)],
    ["Tax", money(invoice.normalizedTax, invoice.currency)],
    ["Total", money(invoice.normalizedTotal, invoice.currency)],
  ];

  return (
    <section className="bg-surface p-3 md:p-4">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-2">
        <p className="eyebrow">Invoice record</p>
        <span className="font-mono text-[11px] text-muted-foreground">{invoice.invoiceNumber}</span>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(260px,.9fr)_minmax(420px,1.1fr)]">
        <section>
          <p className="eyebrow">Header</p>
          <dl className="mt-2 divide-y divide-border text-[12.5px]">
            {details.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[120px_1fr] gap-3 py-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-mono tabular text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="min-w-0">
          <p className="eyebrow">Line items</p>
          <div className="mt-2 overflow-x-auto rounded border border-border">
            <table className="w-full table-fixed text-[11.5px]">
              <thead className="bg-surface-muted text-[10.5px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <Th>Description</Th>
                  <Th>SKU</Th>
                  <Th right>Qty</Th>
                  <Th>Unit</Th>
                  <Th right>Amount</Th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line, index) => (
                  <tr key={`${line.sku}-${index}`} className="border-t border-border">
                    <Td>{line.description}</Td>
                    <Td mono>{line.sku}</Td>
                    <Td right mono>
                      {line.quantity}
                    </Td>
                    <Td>{line.uom}</Td>
                    <Td right mono>
                      {money(line.amount, invoice.currency)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
}

function PurchaseOrderTab({ run }: { run: Run }) {
  const allocation = run.allocation?.lines ?? [];
  const candidate = run.poCandidates?.flatMap((item) => item.lines) ?? [];
  const components = run.bundleCandidates?.flatMap((item) => item.components) ?? [];
  const candidateProposal = !allocation.length && candidate.length > 0;
  const poNumber =
    allocation[0]?.poNumber ??
    run.poCandidates?.[0]?.poNumber ??
    run.bundleCandidates?.[0]?.poNumber ??
    run.invoice?.poNumber;

  if (!poNumber) return <Empty text="No purchase order is available for this invoice." />;

  return (
    <section>
      <p className="font-mono text-[15px] font-semibold text-foreground">{poNumber}</p>
      <p className="mt-0.5 text-[11.5px] text-muted-foreground">
        {run.invoice?.vendor ?? "Vendor not resolved"} · open · {run.invoice?.currency ?? "—"} · net
        price basis
      </p>
      <div className="mt-3 overflow-x-auto rounded border border-border">
        <table className="w-full table-fixed text-[11px]">
          <thead className="bg-surface-muted text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <Th>SKU</Th>
              <Th>Description</Th>
              <Th>UoM</Th>
              <Th right>Unit price</Th>
              {candidateProposal ? (
                <>
                  <Th right>PO ordered</Th>
                  <Th right>Goods received</Th>
                  <Th right>Already invoiced</Th>
                  <Th right>Available to invoice</Th>
                  <Th right>This invoice</Th>
                  <Th right>Invoice PO value</Th>
                </>
              ) : (
                <>
                  <Th right>PO ordered</Th>
                  <Th right>Goods received</Th>
                  <Th right>Already invoiced</Th>
                  <Th right>This invoice</Th>
                  <Th right>Available after posting</Th>
                  <Th right>Invoice PO value</Th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {allocation.map((line) => (
              <tr key={line.poLineId} className="border-t border-border">
                <Td mono>{line.poSku}</Td>
                <Td>{line.poDescription}</Td>
                <Td>{line.uom}</Td>
                <Td right mono>
                  {money(line.poUnitPrice, run.invoice?.currency)}
                </Td>
                <Td right mono>
                  {line.orderedQuantity ?? "—"}
                </Td>
                <Td right mono>
                  {line.receivedQuantity ?? "—"}
                </Td>
                <Td right mono>
                  {line.previouslyInvoicedQuantity ?? "—"}
                </Td>
                <Td right mono>
                  {line.requestedQuantity}
                </Td>
                <Td right mono>
                  {line.receivedAfter}
                </Td>
                <Td right mono>
                  {money(line.poBasis, run.invoice?.currency)}
                </Td>
              </tr>
            ))}
            {!allocation.length &&
              candidate.map((line) => (
                <tr key={line.poLineId} className="border-t border-border">
                  <Td mono>{line.poSku}</Td>
                  <Td>{line.poDescription}</Td>
                  <Td>{line.uom}</Td>
                  <Td right mono>
                    {money(line.poUnitPrice, run.invoice?.currency)}
                  </Td>
                  <Td right mono>
                    {line.orderedQuantity ?? "—"}
                  </Td>
                  <Td right mono>
                    {line.receivedQuantity ?? "—"}
                  </Td>
                  <Td right mono>
                    {line.previouslyInvoicedQuantity ?? "—"}
                  </Td>
                  <Td right mono>
                    {line.receivedAvailable}
                  </Td>
                  <Td right mono>
                    {line.requestedQuantity}
                  </Td>
                  <Td right mono>
                    {money(
                      line.requestedQuantity * line.poUnitPrice,
                      run.invoice?.currency,
                    )}
                  </Td>
                </tr>
              ))}
            {!allocation.length &&
              !candidate.length &&
              components.map((line) => (
                <tr key={line.poLineId} className="border-t border-border">
                  <Td mono>{line.sku}</Td>
                  <Td>{line.description}</Td>
                  <Td>{line.uom}</Td>
                  <Td right mono>
                    {money(line.unitPrice, run.invoice?.currency)}
                  </Td>
                  <Td right mono>
                    —
                  </Td>
                  <Td right mono>
                    —
                  </Td>
                  <Td right mono>
                    —
                  </Td>
                  <Td right mono>
                    {line.quantity}
                  </Td>
                  <Td right mono>
                    {line.receivedAvailable - line.quantity}
                  </Td>
                  <Td right mono>
                    {money(line.poBasis, run.invoice?.currency)}
                  </Td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MatchingTab({ run }: { run: Run }) {
  const allocation = run.allocation?.lines ?? [];
  const candidates =
    run.poCandidates?.flatMap((candidate) =>
      candidate.lines.map((line) => ({ ...line, poNumber: candidate.poNumber })),
    ) ?? [];
  const bundles =
    run.bundleCandidates?.flatMap((bundle) =>
      bundle.components.map((line) => ({
        ...line,
        invoiceDescription: bundle.invoiceItemDescription,
        invoiceSku: bundle.invoiceItemSku ?? "—",
        poNumber: bundle.poNumber,
      })),
    ) ?? [];

  if (run.reasonCode === "DUPLICATE_INVOICE" && run.duplicateMatch) {
    return <DuplicateMatch run={run} />;
  }
  if (!allocation.length && !candidates.length && !bundles.length) {
    return <ExceptionSummary run={run} />;
  }
  const trustedDefinition = allocation.find((line) => line.bundleDefinitionId);

  return (
    <div className="space-y-3">
      {trustedDefinition && (
        <section className="rounded border border-success/25 bg-success-soft/30 px-3 py-2.5">
          <p className="eyebrow text-success">Trusted bundle definition applied</p>
          <p className="mt-1 text-[12.5px] text-foreground">
            <span className="font-mono">{trustedDefinition.bundleDefinitionId}</span> expanded the
            invoice bundle into {allocation.length} PO component{allocation.length === 1 ? "" : "s"}
            .
          </p>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            Those components were used for matching, pricing, and receipt-capacity checks.
          </p>
        </section>
      )}
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full table-fixed text-[11px]">
          <thead className="bg-surface-muted text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <Th>Invoice item</Th>
              <Th>Matched PO line</Th>
              <Th>Method</Th>
              <Th right>This invoice</Th>
              <Th right>Available to invoice</Th>
              <Th right>Inv. price</Th>
              <Th right>PO price</Th>
              <Th right>Available after invoice</Th>
            </tr>
          </thead>
          <tbody>
            {allocation.map((line) => (
              <MatchRow
                key={line.poLineId}
                invoice={line.invoiceDescription}
                invoiceSku={line.invoiceSku}
                po={line.poDescription}
                poSku={line.poSku}
                method={run.allocation?.method}
                requested={line.requestedQuantity}
                available={line.receivedBefore}
                invoicePrice={line.poUnitPrice}
                poPrice={line.poUnitPrice}
                capacity={`${qty(line.receivedAfter)} available`}
                currency={run.invoice?.currency}
              />
            ))}
            {!allocation.length &&
              candidates.map((line) => (
                <MatchRow
                  key={line.poLineId}
                  invoice={line.invoiceDescription}
                  invoiceSku={line.invoiceSku}
                  po={line.poDescription}
                  poSku={line.poSku}
                  method="PROPOSED"
                  requested={line.requestedQuantity}
                  available={line.receivedAvailable}
                  invoicePrice={line.invoiceUnitPrice}
                  poPrice={line.poUnitPrice}
                capacity={`${qty(line.receivedAvailable - line.requestedQuantity)} available`}
                  currency={run.invoice?.currency}
                />
              ))}
            {!allocation.length &&
              !candidates.length &&
              bundles.map((line) => (
                <MatchRow
                  key={line.poLineId}
                  invoice={line.invoiceDescription}
                  invoiceSku={line.invoiceSku}
                  po={line.description}
                  poSku={line.sku}
                  method="PROPOSED COMPONENT"
                  requested={line.quantity}
                  available={line.receivedAvailable}
                  invoicePrice={line.unitPrice}
                  poPrice={line.unitPrice}
                capacity={`${qty(line.receivedAvailable - line.quantity)} available`}
                  currency={run.invoice?.currency}
                />
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MatchRow({
  invoice,
  invoiceSku,
  po,
  poSku,
  method,
  requested,
  available,
  invoicePrice,
  poPrice,
  capacity,
  currency,
}: {
  invoice: string;
  invoiceSku: string;
  po: string;
  poSku: string;
  method: string | undefined;
  requested: number;
  available: number;
  invoicePrice: number;
  poPrice: number;
  capacity: string;
  currency?: string;
}) {
  return (
    <tr className="border-t border-border">
      <Td>
        <div>{invoice}</div>
        <div className="font-mono text-[10.5px] text-muted-foreground">{invoiceSku}</div>
      </Td>
      <Td>
        <div>{po}</div>
        <div className="font-mono text-[10.5px] text-muted-foreground">{poSku}</div>
      </Td>
      <Td>
        <span className="rounded bg-surface-muted px-1.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {method?.replaceAll("_", " ")}
        </span>
      </Td>
      <Td right mono>
        {qty(requested)}
      </Td>
      <Td right mono>
        {qty(available)}
      </Td>
      <Td right mono>
        {money(invoicePrice, currency)}
      </Td>
      <Td right mono>
        {money(poPrice, currency)}
      </Td>
      <Td right mono>
        {capacity}
      </Td>
    </tr>
  );
}

function DuplicateMatch({ run }: { run: Run }) {
  const duplicate = run.duplicateMatch!;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FactGroup
        title="Current invoice"
        rows={[
          ["Invoice #", run.invoice?.invoiceNumber ?? "—"],
          ["PO", run.invoice?.poNumber ?? "—"],
          ["Total", money(run.invoice?.normalizedTotal, run.invoice?.currency)],
        ]}
      />
      <FactGroup
        title="Existing ledger invoice"
        rows={[
          ["Posting", `${duplicate.originalInvoiceNumber} · ${dateLong(duplicate.postedAt)}`],
          ["Technical ID", duplicate.ledgerId],
          ["Invoice #", duplicate.originalInvoiceNumber],
          ["Posted", dateLong(duplicate.postedAt)],
          ["Total", money(duplicate.total, run.invoice?.currency)],
        ]}
      />
    </div>
  );
}

function ExceptionSummary({ run }: { run: Run }) {
  const details =
    run.reasonCode === "EXTRACTION_FAILED"
      ? run.extractionError
      : run.reasonCode === "MAPPING_FAILED"
        ? run.mappingError
        : run.nextAction;
  return (
    <div className="rounded border border-border bg-surface-muted px-3 py-4 text-[13px] text-muted-foreground">
      <p className="font-medium text-foreground">No line-level match is available yet.</p>
      <p className="mt-1">{details ?? "Complete the required review action to continue."}</p>
    </div>
  );
}

function ControlsHistoryTab({ run }: { run: Run }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(240px,.55fr)]">
      <section>
        <p className="eyebrow">Controls</p>
        <ul className="mt-2 overflow-hidden rounded border border-border divide-y divide-border">
          {run.checks.length ? (
            run.checks.map((check) => (
              <li key={check.code} className="flex gap-3 px-3 py-2.5">
                <span
                  className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] ${check.skipped ? "bg-muted text-muted-foreground" : check.pass ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive"}`}
                >
                  {check.skipped ? "–" : check.pass ? "✓" : "!"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-foreground">{check.name}</p>
                  {(check.expected || check.observed) && (
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {check.expected && `expected ${check.expected}`}
                      {check.expected && check.observed && " · "}
                      {check.observed && `observed ${check.observed}`}
                    </p>
                  )}
                </div>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {check.category}
                </span>
              </li>
            ))
          ) : (
            <li className="px-3 py-4 text-[13px] text-muted-foreground">
              No controls have run yet.
            </li>
          )}
        </ul>
        {(run.aiRechecks?.length ?? 0) > 0 && (
          <div className="mt-5">
            <p className="eyebrow">AI re-read provenance</p>
            <ul className="mt-2 overflow-hidden rounded border border-border divide-y divide-border text-[12px]">
              {run.aiRechecks?.map((recheck) => (
                <li key={`${recheck.field}-${recheck.attemptedAt}`} className="px-3 py-2.5">
                  <p className="font-medium text-foreground">
                    {recheck.field} · {recheck.outcome === "resolved" ? "resolved" : "needs review"}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {recheck.model ?? "No model response"} · {dateTime(recheck.attemptedAt)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <section>
        <p className="eyebrow">Processing history</p>
        <ol className="mt-2 space-y-2.5">
          {run.stages.map((stage) => (
            <li key={stage.stage} className="flex gap-2">
              <span
                className={`mt-1.5 h-1.5 w-1.5 rounded-full ${stage.status === "FAILED" ? "bg-destructive" : stage.status === "IN_PROGRESS" ? "bg-warning" : stage.status === "DONE" ? "bg-success" : "bg-muted-foreground"}`}
              />
              <div>
                <p className="text-[12.5px] font-medium text-foreground">{stage.label}</p>
                {stage.detail && (
                  <p className="text-[11px] text-muted-foreground">{stage.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-5 text-[11px] text-muted-foreground">
          Run ID <span className="font-mono">{run.runId}</span> · created {dateTime(run.createdAt)}
        </p>
      </section>
    </div>
  );
}

function FactGroup({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <section className="rounded border border-border px-3 py-3">
      <p className="eyebrow">{title}</p>
      <dl className="mt-2 space-y-1.5 text-[12.5px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono text-right text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-5 text-[13px] text-muted-foreground">{text}</p>;
}
function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-2 py-2 font-medium ${right ? "text-right" : "text-left"}`}>{children}</th>
  );
}
function Td({
  children,
  right = false,
  mono = false,
}: {
  children: React.ReactNode;
  right?: boolean;
  mono?: boolean;
}) {
  return (
    <td
      className={`px-2 py-2 align-top break-words ${right ? "text-right" : "text-left"} ${mono ? "font-mono tabular" : ""}`}
    >
      {children}
    </td>
  );
}
