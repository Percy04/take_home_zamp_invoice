import Database from "better-sqlite3";
import { Decimal } from "decimal.js";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  allocationSchema,
  checkResultSchema,
  normalizedInvoiceSchema,
  runDetailSchema,
  sourceRefSchema,
  stageEventSchema,
  type Allocation,
  type CheckResult,
  type NormalizedInvoice,
  type RunDetail,
  type SourceRef,
  type StageEvent,
} from "../../shared/contracts.js";

type RunRow = {
  id: string;
  created_at: string;
  updated_at: string;
  filename: string;
  pdf_path: string;
  state: RunDetail["state"];
  decision: RunDetail["decision"];
  execution: RunDetail["execution"];
  primary_reason_code: string | null;
  next_action: string | null;
  ledger_invoice_id: string | null;
  extraction_json: string | null;
  evaluation_json: string | null;
  stage_events_json: string;
};

type Evaluation = {
  invoice: NormalizedInvoice | null;
  checks: CheckResult[];
  allocations: Allocation[];
};

export class Storage {
  readonly runtimeDirectory: string;
  private readonly seedPath: string;
  private readonly databasePath: string;
  private db: Database.Database;

  constructor(
    runtimeDirectory: string,
    seedPath = path.resolve("data/seed.sqlite"),
  ) {
    this.runtimeDirectory = path.resolve(runtimeDirectory);
    this.seedPath = seedPath;
    this.databasePath = path.join(this.runtimeDirectory, "runtime.sqlite");
    mkdirSync(this.runtimeDirectory, { recursive: true });
    if (!exists(this.databasePath))
      copyFileSync(this.seedPath, this.databasePath);
    this.db = this.open();
  }

  private open() {
    const db = new Database(this.databasePath);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    return db;
  }

  createRun(input: {
    id: string;
    filename: string;
    sha256: string;
    pdfPath: string;
  }): RunDetail {
    const now = new Date().toISOString();
    const stages: StageEvent[] = [
      { stage: "INTAKE", status: "COMPLETED", at: now },
    ];
    this.db
      .prepare(
        `INSERT INTO runs
         (id, created_at, updated_at, filename, file_sha256, pdf_path, state, stage_events_json)
         VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', ?)`,
      )
      .run(
        input.id,
        now,
        now,
        input.filename,
        input.sha256,
        input.pdfPath,
        JSON.stringify(stages),
      );
    return this.getRun(input.id)!;
  }

  getRun(id: string): RunDetail | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      RunRow | undefined;
    if (!row) return null;
    const evaluation = row.evaluation_json
      ? (JSON.parse(row.evaluation_json) as Evaluation)
      : { invoice: null, checks: [], allocations: [] };
    return runDetailSchema.parse({
      runId: row.id,
      filename: row.filename,
      state: row.state,
      decision: row.decision,
      execution: row.execution,
      reasonCode: row.primary_reason_code,
      nextAction: row.next_action,
      ledgerId: row.ledger_invoice_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stages: stageEventSchema.array().parse(JSON.parse(row.stage_events_json)),
      evidence: row.extraction_json
        ? sourceRefSchema.array().parse(JSON.parse(row.extraction_json))
        : [],
      invoice: evaluation.invoice
        ? normalizedInvoiceSchema.parse(evaluation.invoice)
        : null,
      checks: checkResultSchema.array().parse(evaluation.checks),
      allocations: allocationSchema.array().parse(evaluation.allocations),
    });
  }

  getPdfPath(id: string): string | null {
    const row = this.db
      .prepare("SELECT pdf_path FROM runs WHERE id = ?")
      .get(id) as { pdf_path: string | null } | undefined;
    return row?.pdf_path ?? null;
  }

  addStage(id: string, stage: string, status: StageEvent["status"]) {
    const row = this.db
      .prepare("SELECT stage_events_json FROM runs WHERE id = ?")
      .get(id) as {
      stage_events_json: string;
    };
    const stages = stageEventSchema
      .array()
      .parse(JSON.parse(row.stage_events_json));
    stages.push({ stage, status, at: new Date().toISOString() });
    this.db
      .prepare(
        "UPDATE runs SET stage_events_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(stages), new Date().toISOString(), id);
  }

  saveEvidence(id: string, evidence: SourceRef[]) {
    sourceRefSchema.array().parse(evidence);
    this.db
      .prepare(
        "UPDATE runs SET extraction_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(evidence), new Date().toISOString(), id);
  }

  getHappyContext() {
    return {
      vendors: this.db.prepare("SELECT * FROM vendors WHERE active = 1").all(),
      purchaseOrders: this.db.prepare("SELECT * FROM purchase_orders").all(),
      poLines: this.db.prepare("SELECT * FROM po_lines").all(),
      usedQuantities: this.db
        .prepare(
          `SELECT po_line_id, COALESCE(SUM(CAST(component_quantity AS REAL)), 0) AS quantity
           FROM allocations GROUP BY po_line_id`,
        )
        .all(),
    };
  }

  post(
    id: string,
    invoice: NormalizedInvoice,
    checks: CheckResult[],
    allocations: Allocation[],
  ) {
    const transaction = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM posted_invoices WHERE run_id = ?")
        .get(id) as { id: string } | undefined;
      if (existing) return existing.id;

      const vendor = this.db
        .prepare("SELECT id FROM vendors WHERE normalized_name = ?")
        .get(normalize(invoice.vendor)) as { id: string };
      const duplicate = this.db
        .prepare(
          "SELECT id FROM posted_invoices WHERE vendor_id = ? AND normalized_invoice_number = ?",
        )
        .get(vendor.id, normalize(invoice.invoiceNumber));
      if (duplicate) throw new Error("DUPLICATE");
      for (const allocation of allocations) {
        const capacity = this.db
          .prepare(
            `SELECT p.ordered_quantity, p.received_quantity,
             COALESCE(SUM(CAST(a.component_quantity AS REAL)), 0) AS used_quantity
             FROM po_lines p LEFT JOIN allocations a ON a.po_line_id = p.id
             WHERE p.id = ? GROUP BY p.id`,
          )
          .get(allocation.poLineId) as {
          ordered_quantity: string;
          received_quantity: string;
          used_quantity: number;
        };
        const after = new Decimal(capacity.used_quantity).plus(
          allocation.quantity,
        );
        if (
          after.gt(capacity.ordered_quantity) ||
          after.gt(capacity.received_quantity)
        ) {
          throw new Error("CAPACITY_CHANGED");
        }
      }
      const ledgerId = `LEDGER-${id}`;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO posted_invoices
           (id, run_id, origin, vendor_id, invoice_number, normalized_invoice_number,
            invoice_date, currency, subtotal, tax, total, po_number, posted_at)
           VALUES (?, ?, 'RUN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ledgerId,
          id,
          vendor.id,
          invoice.invoiceNumber,
          normalize(invoice.invoiceNumber),
          invoice.invoiceDate,
          invoice.currency,
          invoice.subtotal,
          invoice.tax,
          invoice.total,
          invoice.poNumber,
          now,
        );
      const insertAllocation = this.db.prepare(
        `INSERT INTO allocations
         (id, posted_invoice_id, invoice_line_index, po_line_id, match_type,
          component_quantity, po_basis_amount, actual_net_amount, evidence_json)
         VALUES (?, ?, ?, ?, 'DIRECT', ?, ?, ?, '{}')`,
      );
      allocations.forEach((allocation, index) =>
        insertAllocation.run(
          `ALLOC-${id}-${index}`,
          ledgerId,
          index,
          allocation.poLineId,
          allocation.quantity,
          allocation.poBasisAmount,
          allocation.actualNetAmount,
        ),
      );
      const evaluation = { invoice, checks, allocations };
      this.db
        .prepare(
          `UPDATE runs SET state = 'POSTED', decision = 'AUTO_CLEARED', execution = 'POSTED',
           vendor_id = ?, normalized_invoice_number = ?, selected_po_number = ?,
           ledger_invoice_id = ?, evaluation_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          vendor.id,
          normalize(invoice.invoiceNumber),
          invoice.poNumber,
          ledgerId,
          JSON.stringify(evaluation),
          now,
          id,
        );
      return ledgerId;
    });
    return transaction();
  }

  block(
    id: string,
    reasonCode: string,
    nextAction: string,
    invoice: NormalizedInvoice | null = null,
    checks: CheckResult[] = [],
  ) {
    this.db
      .prepare(
        `UPDATE runs SET state = 'NEEDS_REVIEW', decision = 'NEEDS_REVIEW', execution = 'BLOCKED',
         primary_reason_code = ?, next_action = ?, evaluation_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        reasonCode,
        nextAction,
        JSON.stringify({ invoice, checks, allocations: [] }),
        new Date().toISOString(),
        id,
      );
  }

  reset() {
    this.db.close();
    rmSync(this.databasePath, { force: true });
    rmSync(path.join(this.runtimeDirectory, "uploads"), {
      recursive: true,
      force: true,
    });
    copyFileSync(this.seedPath, this.databasePath);
    this.db = this.open();
  }

  close() {
    this.db.close();
  }
}

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function exists(file: string) {
  return existsSync(file);
}
