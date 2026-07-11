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
          { matchType: "BUNDLE_MASTER", bundleDefinitionId: "BUNDLE-ACME-KIT-300" },
          { matchType: "BUNDLE_MASTER", bundleDefinitionId: "BUNDLE-ACME-KIT-300" },
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
});
