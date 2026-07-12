import Database from "better-sqlite3";
import { Decimal } from "decimal.js";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  allocationSchema,
  bundleCandidateSchema,
  checkResultSchema,
  normalizedInvoiceSchema,
  poCandidateSchema,
  runDetailSchema,
  runSummarySchema,
  sourceRefSchema,
  stageEventSchema,
  type Allocation,
  type BundleCandidate,
  type CheckResult,
  type DuplicateMatch,
  type InvoicePreview,
  type NormalizedInvoice,
  type PoCandidate,
  type RunDetail,
  type RunSummary,
  type SourceRef,
  type StageEvent,
} from "../../shared/contracts.js";
import { buildUnknownBundleCandidates, evaluateInvoice } from "./controls.js";

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
  candidates_json: string | null;
  bundle_candidates_json: string | null;
  stage_events_json: string;
};

type Evaluation = {
  invoice: NormalizedInvoice | null;
  checks: CheckResult[];
  allocations: Allocation[];
  invoicePreview?: InvoicePreview | null;
  duplicateMatch?: DuplicateMatch | null;
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
    this.migrate();
  }

  private open() {
    const db = new Database(this.databasePath);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    return db;
  }

  private migrate() {
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "idempotency_key"))
      this.db.exec("ALTER TABLE runs ADD COLUMN idempotency_key TEXT");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_key ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL",
    );
  }

  createRun(input: {
    id: string;
    filename: string;
    sha256: string;
    pdfPath: string;
    idempotencyKey?: string;
  }): RunDetail {
    const now = new Date().toISOString();
    const stages: StageEvent[] = [
      { stage: "INTAKE", status: "COMPLETED", at: now },
    ];
    this.db
      .prepare(
        `INSERT INTO runs
         (id, created_at, updated_at, filename, file_sha256, pdf_path, state, stage_events_json, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', ?, ?)`,
      )
      .run(
        input.id,
        now,
        now,
        input.filename,
        input.sha256,
        input.pdfPath,
        JSON.stringify(stages),
        input.idempotencyKey ?? null,
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
      invoicePreview: evaluation.invoicePreview ?? null,
      duplicateMatch: evaluation.duplicateMatch ?? null,
      checks: checkResultSchema.array().parse(evaluation.checks),
      allocations: allocationSchema.array().parse(evaluation.allocations),
      candidatePo: parsePoCandidates(row.candidates_json)[0]?.poNumber ?? null,
      poCandidates: parsePoCandidates(row.candidates_json),
      bundleCandidates: bundleCandidateSchema
        .array()
        .parse(JSON.parse(row.bundle_candidates_json ?? "[]")),
    });
  }

  listRuns(
    input: {
      state?: RunSummary["state"];
      limit?: number;
      cursor?: string;
    } = {},
  ) {
    const limit = input.limit ?? 25;
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.state) {
      conditions.push("state = ?");
      parameters.push(input.state);
    }
    if (cursor) {
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, filename, state, decision, execution, primary_reason_code,
         ledger_invoice_id, created_at, updated_at,
         json_extract(evaluation_json, '$.invoice.vendor') AS vendor,
         json_extract(evaluation_json, '$.invoice.invoiceNumber') AS invoice_number,
         json_extract(evaluation_json, '$.invoice.total') AS total,
         json_extract(evaluation_json, '$.invoice.currency') AS currency
         FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters, limit + 1) as Array<{
      id: string;
      filename: string;
      state: RunSummary["state"];
      decision: RunSummary["decision"];
      execution: RunSummary["execution"];
      primary_reason_code: string | null;
      ledger_invoice_id: string | null;
      vendor: string | null;
      invoice_number: string | null;
      total: string | null;
      currency: "USD" | null;
      created_at: string;
      updated_at: string;
    }>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = runSummarySchema.array().parse(
      page.map((row) => ({
        runId: row.id,
        filename: row.filename,
        vendor: row.vendor,
        invoiceNumber: row.invoice_number,
        total: row.total,
        currency: row.currency,
        state: row.state,
        decision: row.decision,
        execution: row.execution,
        reasonCode: row.primary_reason_code,
        ledgerId: row.ledger_invoice_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    );
    const last = page.at(-1);
    const metrics = this.db
      .prepare(
        `SELECT COUNT(*) AS total_runs,
         SUM(CASE WHEN state = 'POSTED' THEN 1 ELSE 0 END) AS posted_count,
         SUM(CASE WHEN state IN ('NEEDS_REVIEW', 'AWAITING_PO_CONFIRMATION', 'AWAITING_BUNDLE_CONFIRMATION') THEN 1 ELSE 0 END) AS review_count
         FROM runs`,
      )
      .get() as {
      total_runs: number;
      posted_count: number;
      review_count: number;
    };
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.created_at, id: last.id })
          : null,
      metrics: {
        totalRuns: metrics.total_runs,
        postedCount: metrics.posted_count,
        reviewCount: metrics.review_count,
        autoClearRate:
          metrics.total_runs === 0
            ? "0.0"
            : new Decimal(metrics.posted_count)
                .div(metrics.total_runs)
                .mul(100)
                .toFixed(1),
      },
    };
  }

  getRunByIdempotencyKey(key: string) {
    const row = this.db
      .prepare("SELECT id FROM runs WHERE idempotency_key = ?")
      .get(key) as { id: string } | undefined;
    return row ? this.getRun(row.id) : null;
  }

  ping() {
    return this.db.prepare("SELECT 1 AS ok").get() as { ok: number };
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
      postedInvoices: this.db
        .prepare(
          "SELECT vendor_id, normalized_invoice_number FROM posted_invoices",
        )
        .all(),
      bundleDefinitions: this.db
        .prepare("SELECT * FROM bundle_definitions WHERE active = 1")
        .all(),
      priorAllocations: this.db
        .prepare(
          "SELECT po_line_id, component_quantity, po_basis_amount FROM allocations",
        )
        .all(),
    };
  }

  getEvaluation(id: string): Evaluation | null {
    const row = this.db
      .prepare("SELECT evaluation_json FROM runs WHERE id = ?")
      .get(id) as { evaluation_json: string | null } | undefined;
    return row?.evaluation_json
      ? (JSON.parse(row.evaluation_json) as Evaluation)
      : null;
  }

  findDuplicate(invoice: NormalizedInvoice): DuplicateMatch | null {
    const vendor = this.db
      .prepare("SELECT id FROM vendors WHERE normalized_name = ?")
      .get(normalize(invoice.vendor)) as { id: string } | undefined;
    if (!vendor) return null;
    const posted = this.db
      .prepare(
        `SELECT id, invoice_number, invoice_date, po_number, total, posted_at
         FROM posted_invoices WHERE vendor_id = ? AND normalized_invoice_number = ?`,
      )
      .get(vendor.id, normalize(invoice.invoiceNumber)) as
      | {
          id: string;
          invoice_number: string;
          invoice_date: string;
          po_number: string;
          total: string;
          posted_at: string;
        }
      | undefined;
    if (!posted) return null;
    const allocations = this.db
      .prepare(
        `SELECT a.po_line_id, a.component_quantity, a.po_basis_amount,
                p.sku, p.description, p.uom, p.unit_price
         FROM allocations a JOIN po_lines p ON p.id = a.po_line_id
         WHERE a.posted_invoice_id = ? ORDER BY a.invoice_line_index, a.id`,
      )
      .all(posted.id) as Array<{
      po_line_id: string;
      component_quantity: string;
      po_basis_amount: string;
      sku: string | null;
      description: string;
      uom: string;
      unit_price: string;
    }>;
    return {
      ledgerId: posted.id,
      invoiceNumber: posted.invoice_number,
      invoiceDate: posted.invoice_date,
      poNumber: posted.po_number,
      total: posted.total,
      postedAt: posted.posted_at,
      allocations: allocations.map((allocation) => ({
        poLineId: allocation.po_line_id,
        sku: allocation.sku ?? "",
        description: allocation.description,
        uom: allocation.uom,
        quantity: allocation.component_quantity,
        unitPrice: allocation.unit_price,
        poBasisAmount: allocation.po_basis_amount,
      })),
    };
  }

  findPoCandidates(
    invoice: NormalizedInvoice,
    includeUnresolved = false,
  ): PoCandidate[] {
    const vendor = this.db
      .prepare("SELECT id FROM vendors WHERE normalized_name = ?")
      .get(normalize(invoice.vendor)) as { id: string } | undefined;
    if (!vendor) return [];
    const purchaseOrders = this.db
      .prepare(
        "SELECT * FROM purchase_orders WHERE vendor_id = ? AND status = 'OPEN' AND currency = ?",
      )
      .all(vendor.id, invoice.currency) as Array<{ po_number: string }>;
    const context = this.getHappyContext();
    return poCandidateSchema.array().parse(
      purchaseOrders
        .map((po) => {
          const candidateInvoice = { ...invoice, poNumber: po.po_number };
          let matchedLineCount: number;
          let allLinesResolvable: boolean;
          let lines: PoCandidate["lines"] = [];
          try {
            const evaluation = evaluateInvoice(candidateInvoice, context);
            matchedLineCount = invoice.lines.length;
            allLinesResolvable = true;
            lines = evaluation.allocations.map((allocation) => {
              const invoiceLine = invoice.lines[allocation.invoiceLineIndex]!;
              return {
                invoiceLineIndex: allocation.invoiceLineIndex,
                invoiceSku: invoiceLine.sku,
                invoiceDescription: invoiceLine.description,
                requestedQuantity: allocation.quantity,
                uom: invoiceLine.uom,
                poLineId: allocation.poLineId,
                poSku: allocation.sku,
                poDescription: allocation.poDescription ?? allocation.sku,
                poUnitPrice: allocation.poUnitPrice ?? "0.00",
                availableOrderedQuantity:
                  allocation.availableOrderedQuantity ?? allocation.quantity,
                availableReceivedQuantity:
                  allocation.availableReceivedQuantity ?? allocation.quantity,
              };
            });
          } catch {
            allLinesResolvable = false;
            const poLines = context.poLines as Array<{
              id: string;
              po_number: string;
              sku: string | null;
              description: string;
              normalized_sku: string | null;
              normalized_description: string;
              uom: string;
              unit_price: string;
              ordered_quantity: string;
              received_quantity: string;
            }>;
            const priorAllocations = context.priorAllocations as Array<{
              po_line_id: string;
              component_quantity: string;
            }>;
            lines = invoice.lines.flatMap((line, invoiceLineIndex) => {
              const poLine = poLines.find(
                (candidate) =>
                  candidate.po_number === po.po_number &&
                  candidate.uom === line.uom &&
                  (line.sku
                    ? candidate.normalized_sku === normalize(line.sku)
                    : candidate.normalized_description ===
                      normalize(line.description)),
              );
              if (!poLine) return [];
              const consumed = priorAllocations
                .filter((allocation) => allocation.po_line_id === poLine.id)
                .reduce(
                  (total, allocation) =>
                    total.plus(allocation.component_quantity),
                  new Decimal(0),
                );
              return [
                {
                  invoiceLineIndex,
                  invoiceSku: line.sku,
                  invoiceDescription: line.description,
                  requestedQuantity: line.quantity,
                  uom: line.uom,
                  poLineId: poLine.id,
                  poSku: poLine.sku ?? "",
                  poDescription: poLine.description,
                  poUnitPrice: poLine.unit_price,
                  availableOrderedQuantity: new Decimal(poLine.ordered_quantity)
                    .minus(consumed)
                    .toString(),
                  availableReceivedQuantity: new Decimal(
                    poLine.received_quantity,
                  )
                    .minus(consumed)
                    .toString(),
                },
              ];
            });
            matchedLineCount = lines.length;
          }
          const poLines = this.db
            .prepare("SELECT * FROM po_lines WHERE po_number = ?")
            .all(po.po_number) as Array<{
            ordered_quantity: string;
            unit_price: string;
          }>;
          const totalBasis = poLines.reduce(
            (sum, line) =>
              sum.plus(new Decimal(line.ordered_quantity).mul(line.unit_price)),
            new Decimal(0),
          );
          const priorBasis = this.db
            .prepare(
              `SELECT a.po_basis_amount FROM allocations a
               JOIN po_lines p ON p.id = a.po_line_id WHERE p.po_number = ?`,
            )
            .all(po.po_number) as Array<{ po_basis_amount: string }>;
          const remaining = priorBasis.reduce(
            (value, row) => value.minus(row.po_basis_amount),
            totalBasis,
          );
          return {
            poNumber: po.po_number,
            allLinesResolvable,
            matchedLineCount,
            remainingPoBasisValue: remaining.toFixed(2),
            subtotalDifference: remaining
              .minus(invoice.subtotal)
              .abs()
              .toFixed(2),
            lines,
          };
        })
        .filter((candidate) =>
          includeUnresolved
            ? candidate.matchedLineCount > 0
            : candidate.allLinesResolvable,
        )
        .sort(
          (left, right) =>
            Number(right.allLinesResolvable) -
              Number(left.allLinesResolvable) ||
            right.matchedLineCount - left.matchedLineCount ||
            new Decimal(left.subtotalDifference).comparedTo(
              right.subtotalDifference,
            ) ||
            normalize(left.poNumber).localeCompare(normalize(right.poNumber)),
        )
        .slice(0, 3),
    );
  }

  findBundleCandidates(invoice: NormalizedInvoice): BundleCandidate[] {
    const context = this.getHappyContext();
    return buildUnknownBundleCandidates(
      invoice,
      context.poLines,
      context.priorAllocations,
    );
  }

  awaitPoConfirmation(
    id: string,
    invoice: NormalizedInvoice,
    checks: CheckResult[],
    candidates: PoCandidate[],
    nextAction: string,
  ) {
    this.db
      .prepare(
        `UPDATE runs SET state = 'AWAITING_PO_CONFIRMATION', decision = 'NEEDS_REVIEW',
         execution = 'AWAITING_CONFIRMATION', primary_reason_code = 'MISSING_PO',
         next_action = ?, evaluation_json = ?, candidates_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        nextAction,
        JSON.stringify({ invoice, checks, allocations: [] }),
        JSON.stringify(candidates),
        new Date().toISOString(),
        id,
      );
  }

  awaitBundleConfirmation(
    id: string,
    invoice: NormalizedInvoice,
    checks: CheckResult[],
    candidates: BundleCandidate[],
    nextAction: string,
  ) {
    this.db
      .prepare(
        `UPDATE runs SET state = 'AWAITING_BUNDLE_CONFIRMATION', decision = 'NEEDS_REVIEW',
         execution = 'AWAITING_CONFIRMATION', primary_reason_code = 'BUNDLE_MAPPING_REQUIRED',
         next_action = ?, evaluation_json = ?, bundle_candidates_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        nextAction,
        JSON.stringify({ invoice, checks, allocations: [] }),
        JSON.stringify(candidates),
        new Date().toISOString(),
        id,
      );
  }

  getPoCandidates(id: string) {
    const row = this.db
      .prepare("SELECT candidates_json FROM runs WHERE id = ?")
      .get(id) as { candidates_json: string | null } | undefined;
    return parsePoCandidates(row?.candidates_json ?? null);
  }

  getBundleCandidates(id: string) {
    const row = this.db
      .prepare("SELECT bundle_candidates_json FROM runs WHERE id = ?")
      .get(id) as { bundle_candidates_json: string | null } | undefined;
    return bundleCandidateSchema
      .array()
      .parse(JSON.parse(row?.bundle_candidates_json ?? "[]"));
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
            "SELECT ordered_quantity, received_quantity FROM po_lines WHERE id = ?",
          )
          .get(allocation.poLineId) as {
          ordered_quantity: string;
          received_quantity: string;
        };
        const prior = this.db
          .prepare(
            "SELECT component_quantity FROM allocations WHERE po_line_id = ?",
          )
          .all(allocation.poLineId) as Array<{ component_quantity: string }>;
        const after = prior
          .reduce(
            (sum, row) => sum.plus(row.component_quantity),
            new Decimal(0),
          )
          .plus(allocation.quantity);
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
          bundle_definition_id, component_quantity, po_basis_amount, actual_net_amount, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
      );
      allocations.forEach((allocation, index) =>
        insertAllocation.run(
          `ALLOC-${id}-${index}`,
          ledgerId,
          allocation.invoiceLineIndex,
          allocation.poLineId,
          allocation.matchType,
          allocation.bundleDefinitionId,
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
           primary_reason_code = NULL, next_action = NULL,
           candidates_json = '[]', bundle_candidates_json = '[]',
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
    return transaction.immediate();
  }

  block(
    id: string,
    reasonCode: string,
    nextAction: string,
    invoice: NormalizedInvoice | null = null,
    checks: CheckResult[] = [],
    evidence: {
      invoicePreview?: InvoicePreview | null;
      duplicateMatch?: DuplicateMatch | null;
      poCandidates?: PoCandidate[];
      bundleCandidates?: BundleCandidate[];
    } = {},
  ) {
    this.db
      .prepare(
        `UPDATE runs SET state = 'NEEDS_REVIEW', decision = 'NEEDS_REVIEW', execution = 'BLOCKED',
         primary_reason_code = ?, next_action = ?, evaluation_json = ?,
         candidates_json = ?, bundle_candidates_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        reasonCode,
        nextAction,
        JSON.stringify({
          invoice,
          checks,
          allocations: [],
          invoicePreview: evidence.invoicePreview ?? null,
          duplicateMatch: evidence.duplicateMatch ?? null,
        }),
        JSON.stringify(evidence.poCandidates ?? []),
        JSON.stringify(evidence.bundleCandidates ?? []),
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
    this.migrate();
  }

  close() {
    this.db.close();
  }
}

function parsePoCandidates(value: string | null): PoCandidate[] {
  if (!value) return [];
  return poCandidateSchema.array().parse(JSON.parse(value));
}

function encodeCursor(cursor: { createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string) {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string")
      throw new Error("INVALID_CURSOR");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error("INVALID_CURSOR");
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
