import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/src/app.js";
import { Storage } from "../server/src/storage.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true });
});

describe("happy-path vertical slice", () => {
  it("persists, posts exactly once, and restores the complete run", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-phase-1-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });

    await request(app).post("/api/reset").expect(200);
    const created = await request(app)
      .post("/api/runs")
      .attach("invoice", path.resolve("data/fixtures/happy.pdf"))
      .expect(201);
    const processed = await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);
    const retried = await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);
    const restored = await request(app)
      .get(`/api/runs/${created.body.runId}`)
      .expect(200);

    expect(processed.body).toMatchObject({
      state: "POSTED",
      decision: "AUTO_CLEARED",
      execution: "POSTED",
      invoice: { subtotal: "900.00", tax: "90.00", total: "990.00" },
    });
    expect(processed.body.allocations).toHaveLength(2);
    expect(retried.body.ledgerId).toBe(processed.body.ledgerId);
    expect(restored.body).toEqual(retried.body);

    const database = new Database(path.join(runtime, "runtime.sqlite"), {
      readonly: true,
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM posted_invoices WHERE run_id = ?",
        )
        .get(created.body.runId),
    ).toEqual({ count: 1 });
    database.close();
    storage.close();
  });

  it.each([
    ["duplicate.pdf", "DUPLICATE", /do not repost/i],
    ["receipt_capacity.pdf", "RECEIPT_CAPACITY_EXCEEDED", /goods receipt/i],
  ])("blocks %s without posting", async (fixture, reasonCode, nextAction) => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-phase-1-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });

    const created = await request(app)
      .post("/api/runs")
      .attach("invoice", path.resolve(`data/fixtures/${fixture}`))
      .expect(201);
    const processed = await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);

    expect(processed.body).toMatchObject({
      state: "NEEDS_REVIEW",
      decision: "NEEDS_REVIEW",
      execution: "BLOCKED",
      reasonCode,
      nextAction: expect.stringMatching(nextAction),
      ledgerId: null,
    });
    if (reasonCode === "RECEIPT_CAPACITY_EXCEEDED")
      expect(processed.body.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "RECEIPT_CAPACITY",
            passed: false,
            expected: "2 received units available for VAL-500",
            actual: "3 invoice units requested for VAL-500",
          }),
        ]),
      );
    if (reasonCode === "DUPLICATE")
      expect(processed.body.duplicateMatch).toMatchObject({
        ledgerId: "LEDGER-SEED-001",
        invoiceNumber: "ACME-2026-000",
        poNumber: "PO-0999",
        total: "110.00",
        allocations: [
          {
            sku: "FIL-900",
            description: "Replacement Filter",
            quantity: "1",
            unitPrice: "100.00",
          },
        ],
      });

    const database = new Database(path.join(runtime, "runtime.sqlite"), {
      readonly: true,
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM posted_invoices WHERE run_id = ?",
        )
        .get(created.body.runId),
    ).toEqual({ count: 0 });
    database.close();
    storage.close();
  });

  it.each([
    [
      "tax_inclusive.pdf",
      {
        invoice: { subtotal: "500.00", tax: "90.00", total: "590.00" },
        allocations: [{ matchType: "DIRECT", actualNetAmount: "500.00" }],
      },
    ],
    [
      "bundle_known.pdf",
      {
        invoice: { subtotal: "300.00", tax: "0.00", total: "300.00" },
        allocations: [
          {
            matchType: "BUNDLE_MASTER",
            bundleDefinitionId: "BUNDLE-ACME-KIT-300",
          },
          {
            matchType: "BUNDLE_MASTER",
            bundleDefinitionId: "BUNDLE-ACME-KIT-300",
          },
        ],
      },
    ],
  ])("posts %s with Phase 2 allocation behavior", async (fixture, expected) => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-phase-2-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });

    const created = await request(app)
      .post("/api/runs")
      .attach("invoice", path.resolve(`data/fixtures/${fixture}`))
      .expect(201);
    const processed = await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);
    const retried = await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);

    expect(processed.body).toMatchObject({
      state: "POSTED",
      decision: "AUTO_CLEARED",
      execution: "POSTED",
      invoice: expected.invoice,
      allocations: expected.allocations,
    });
    expect(processed.body.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          poDescription: expect.any(String),
          poUnitPrice: expect.any(String),
          availableReceivedQuantity: expect.any(String),
        }),
      ]),
    );
    expect(retried.body.ledgerId).toBe(processed.body.ledgerId);

    const database = new Database(path.join(runtime, "runtime.sqlite"), {
      readonly: true,
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM posted_invoices WHERE run_id = ?",
        )
        .get(created.body.runId),
    ).toEqual({ count: 1 });
    database.close();
    storage.close();
  });

  it("awaits and confirms the missing-PO candidate on the same run", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-phase-3-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });

    const created = await request(app)
      .post("/api/runs")
      .attach("invoice", path.resolve("data/fixtures/missing_po.pdf"))
      .expect(201);
    const awaiting = await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);
    const confirmed = await request(app)
      .post(`/api/runs/${created.body.runId}/confirm-po`)
      .send({ poNumber: "PO-1002" })
      .expect(200);
    const retried = await request(app)
      .post(`/api/runs/${created.body.runId}/confirm-po`)
      .send({ poNumber: "PO-1002" })
      .expect(200);

    expect(awaiting.body).toMatchObject({
      state: "AWAITING_PO_CONFIRMATION",
      execution: "AWAITING_CONFIRMATION",
      reasonCode: "MISSING_PO",
      candidatePo: "PO-1002",
      ledgerId: null,
      poCandidates: [
        {
          poNumber: "PO-1002",
          lines: [
            {
              invoiceDescription: "Safety Sensor",
              poDescription: "Safety Sensor",
              requestedQuantity: "2",
              poUnitPrice: "250.00",
              availableReceivedQuantity: "2",
            },
          ],
        },
      ],
    });
    expect(confirmed.body).toMatchObject({
      runId: created.body.runId,
      state: "POSTED",
      decision: "AUTO_CLEARED",
      execution: "POSTED",
      invoice: { poNumber: "PO-1002", subtotal: "502.00" },
      allocations: [{ poNumber: "PO-1002", matchType: "DIRECT" }],
    });
    expect(retried.body.ledgerId).toBe(confirmed.body.ledgerId);
    storage.close();
  });

  it("blocks a repeated missing-PO invoice as a duplicate without offering stale candidates", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-repeat-missing-po-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });

    const first = await request(app)
      .post("/api/runs")
      .field("fixtureId", "missing_po")
      .expect(201);
    const awaiting = await request(app)
      .post(`/api/runs/${first.body.runId}/process`)
      .expect(200);
    await request(app)
      .post(`/api/runs/${first.body.runId}/confirm-po`)
      .send({ poNumber: awaiting.body.candidatePo })
      .expect(200);
    const postedInvoice = storage.getEvaluation(first.body.runId)!.invoice!;
    expect(
      storage.findPoCandidates({
        ...postedInvoice,
        invoiceNumber: "ACME-2026-NOT-A-DUPLICATE",
        poNumber: "",
      }),
    ).toEqual([]);

    const second = await request(app)
      .post("/api/runs")
      .field("fixtureId", "missing_po")
      .expect(201);
    const repeated = await request(app)
      .post(`/api/runs/${second.body.runId}/process`)
      .expect(200);

    expect(repeated.body).toMatchObject({
      state: "NEEDS_REVIEW",
      reasonCode: "DUPLICATE",
      candidatePo: null,
      poCandidates: [],
    });
    storage.close();
  });

  it("lets a reviewer decline every stored PO candidate", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-decline-po-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });
    const created = await request(app)
      .post("/api/runs")
      .field("fixtureId", "missing_po")
      .expect(201);
    await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);

    const declined = await request(app)
      .post(`/api/runs/${created.body.runId}/reject-po`)
      .expect(200);

    expect(declined.body).toMatchObject({
      state: "NEEDS_REVIEW",
      execution: "BLOCKED",
      reasonCode: "MISSING_PO",
      candidatePo: null,
      poCandidates: [],
    });
    await request(app)
      .post(`/api/runs/${created.body.runId}/confirm-po`)
      .send({ poNumber: "PO-1002" })
      .expect(409);
    storage.close();
  });

  it("reports independent price and receipt failures together", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-multi-issue-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const database = new Database(path.join(runtime, "runtime.sqlite"));
    database
      .prepare(
        "UPDATE po_lines SET unit_price = '50.00', received_quantity = '0' WHERE po_number = 'PO-1001' AND sku = 'WID-100'",
      )
      .run();
    database.close();
    const app = createApp({ storage });
    const created = await request(app)
      .post("/api/runs")
      .field("fixtureId", "happy")
      .expect(201);

    const processed = await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);
    const failedCodes = processed.body.checks
      .filter((check: { passed: boolean }) => !check.passed)
      .map((check: { code: string }) => check.code);

    expect(processed.body.reasonCode).toBe("PRICE_VARIANCE_EXCEEDED");
    expect(failedCodes).toEqual(
      expect.arrayContaining(["PRICE_MATCH", "RECEIPT_CAPACITY"]),
    );
    storage.close();
  });

  it("awaits and confirms an unknown bundle decomposition on the same run", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-phase-3-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });

    const created = await request(app)
      .post("/api/runs")
      .attach("invoice", path.resolve("data/fixtures/bundle_unknown.pdf"))
      .expect(201);
    const awaiting = await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);
    const confirmed = await request(app)
      .post(`/api/runs/${created.body.runId}/confirm-bundle`)
      .send({ candidateId: "BUNDLE-CANDIDATE-1" })
      .expect(200);
    const retried = await request(app)
      .post(`/api/runs/${created.body.runId}/confirm-bundle`)
      .send({ candidateId: "BUNDLE-CANDIDATE-1" })
      .expect(200);

    expect(awaiting.body).toMatchObject({
      state: "AWAITING_BUNDLE_CONFIRMATION",
      execution: "AWAITING_CONFIRMATION",
      reasonCode: "BUNDLE_MAPPING_REQUIRED",
      bundleCandidates: [
        {
          id: "BUNDLE-CANDIDATE-1",
          totalPoBasisAmount: "300.00",
          components: [
            {
              sku: "WID-100",
              description: "Industrial Widget",
              unitPrice: "100.00",
              availableReceivedQuantity: "2",
            },
            {
              sku: "BOL-200",
              description: "Mounting Bolt Pack",
              unitPrice: "20.00",
              availableReceivedQuantity: "5",
            },
          ],
        },
      ],
      ledgerId: null,
    });
    expect(confirmed.body).toMatchObject({
      runId: created.body.runId,
      state: "POSTED",
      decision: "AUTO_CLEARED",
      execution: "POSTED",
      allocations: [
        { matchType: "BUNDLE_CONFIRMED", bundleDefinitionId: null },
        { matchType: "BUNDLE_CONFIRMED", bundleDefinitionId: null },
      ],
    });
    expect(retried.body.ledgerId).toBe(confirmed.body.ledgerId);
    storage.close();
  });

  it("keeps bundle evidence when a reviewer rejects a proposed decomposition", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-reject-bundle-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });
    const created = await request(app)
      .post("/api/runs")
      .field("fixtureId", "bundle_unknown")
      .expect(201);
    await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);

    const rejected = await request(app)
      .post(`/api/runs/${created.body.runId}/reject-bundle`)
      .expect(200);

    expect(rejected.body).toMatchObject({
      state: "NEEDS_REVIEW",
      execution: "BLOCKED",
      reasonCode: "BUNDLE_MAPPING_REQUIRED",
      bundleCandidates: [{ id: "BUNDLE-CANDIDATE-1" }],
    });
    storage.close();
  });

  it.each([
    ["happy", "POSTED", null],
    ["duplicate", "NEEDS_REVIEW", "DUPLICATE"],
    ["missing_po", "POSTED", null],
    ["receipt_capacity", "NEEDS_REVIEW", "RECEIPT_CAPACITY_EXCEEDED"],
    ["happy_layout_b", "POSTED", null],
    ["happy_layout_c_scanned", "POSTED", null],
    ["bundle_known", "POSTED", null],
    ["bundle_unknown", "POSTED", null],
    ["tax_inclusive", "POSTED", null],
  ])("runs canonical fixture %s", async (fixtureId, finalState, reasonCode) => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-all-fixtures-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });

    const created = await request(app)
      .post("/api/runs")
      .field("fixtureId", fixtureId)
      .expect(201);
    let result = await request(app)
      .post(`/api/runs/${created.body.runId}/process`)
      .expect(200);

    if (result.body.state === "AWAITING_PO_CONFIRMATION") {
      result = await request(app)
        .post(`/api/runs/${created.body.runId}/confirm-po`)
        .send({ poNumber: result.body.candidatePo })
        .expect(200);
    }
    if (result.body.state === "AWAITING_BUNDLE_CONFIRMATION") {
      result = await request(app)
        .post(`/api/runs/${created.body.runId}/confirm-bundle`)
        .send({ candidateId: result.body.bundleCandidates[0].id })
        .expect(200);
    }

    expect(result.body).toMatchObject({
      state: finalState,
      reasonCode,
    });
    storage.close();
  });
});
