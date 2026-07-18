import type { Express } from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/src/app.js";
import { Storage } from "../server/src/storage.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

async function waitForRun(app: Express, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(app).get(`/api/runs/${runId}`).expect(200);
    if (response.body.state !== "PROCESSING") return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not finish processing.`);
}

function setup(prefix = "zamp-api-") {
  const runtime = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(runtime);
  const storage = new Storage(runtime);
  return { app: createApp({ storage }), runtime, storage };
}

describe("GET /api/health", () => {
  it("reports that the application is ready", async () => {
    const response = await request(createApp()).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", database: "not-initialized" });
    expect(response.headers["content-security-policy"]).toContain("font-src 'self' https://fonts.gstatic.com");
  });
});

describe("run creation", () => {
  it("creates a processing run immediately, then completes it in the background", async () => {
    const { app, storage } = setup();
    const created = await request(app).post("/api/runs").field("fixtureId", "happy").expect(201);

    expect(created.headers.location).toBe(`/api/runs/${created.body.runId}`);
    expect(created.body).toMatchObject({ state: "PROCESSING", filename: "happy.pdf" });
    expect((await waitForRun(app, created.body.runId)).body).toMatchObject({ state: "POSTED", execution: "POSTED" });
    storage.close();
  });

  it("reuses an idempotent processing run without duplicate ledger work", async () => {
    const { app, runtime, storage } = setup("zamp-idempotency-");
    const first = await request(app).post("/api/runs").set("Idempotency-Key", "same-upload").field("fixtureId", "happy").expect(201);
    const retried = await request(app).post("/api/runs").set("Idempotency-Key", "same-upload").field("fixtureId", "duplicate").expect(200);
    const finished = await waitForRun(app, first.body.runId);

    expect(retried.body.runId).toBe(first.body.runId);
    expect(finished.body.state).toBe("POSTED");
    const Database = (await import("better-sqlite3")).default;
    const database = new Database(path.join(runtime, "runtime.sqlite"), { readonly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM posted_invoices WHERE run_id = ?").get(first.body.runId)).toEqual({ count: 1 });
    database.close();
    storage.close();
  });
});

describe("GET /api/runs", () => {
  it("returns every run newest first in the small items envelope", async () => {
    const { app, storage } = setup();
    const first = await request(app).post("/api/runs").field("fixtureId", "happy").expect(201);
    const second = await request(app).post("/api/runs").field("fixtureId", "duplicate").expect(201);
    await Promise.all([waitForRun(app, first.body.runId), waitForRun(app, second.body.runId)]);

    const listed = await request(app).get("/api/runs").expect(200);
    expect(Object.keys(listed.body)).toEqual(["items"]);
    expect(listed.body.items.map((item: { runId: string }) => item.runId)).toEqual([second.body.runId, first.body.runId]);
    await request(app).get("/api/runs?state=POSTED").expect(400);
    await request(app).get("/api/runs?limit=1").expect(400);
    await request(app).get("/api/runs?cursor=ignored").expect(400);
    storage.close();
  });
});

describe("POST /api/runs/:runId/review", () => {
  it("supports all four review actions and at-most-once posting", async () => {
    const { app, storage } = setup();
    const rejected = setup("zamp-review-reject-");
    const missingPo = await request(app).post("/api/runs").field("fixtureId", "missing_po").expect(201);
    const awaitingPo = await waitForRun(app, missingPo.body.runId);
    const confirmedPo = await request(app)
      .post(`/api/runs/${missingPo.body.runId}/review`)
      .send({ action: "confirm_po", poNumber: awaitingPo.body.candidatePo })
      .expect(200);
    const retriedPo = await request(app)
      .post(`/api/runs/${missingPo.body.runId}/review`)
      .send({ action: "confirm_po", poNumber: awaitingPo.body.candidatePo })
      .expect(200);

    expect(confirmedPo.body).toMatchObject({ state: "POSTED", execution: "POSTED" });
    expect(retriedPo.body.ledgerId).toBe(confirmedPo.body.ledgerId);

    const declinedPo = await request(rejected.app).post("/api/runs").field("fixtureId", "missing_po").expect(201);
    await waitForRun(rejected.app, declinedPo.body.runId);
    expect(
      (await request(rejected.app).post(`/api/runs/${declinedPo.body.runId}/review`).send({ action: "reject_po" }).expect(200)).body,
    ).toMatchObject({ state: "NEEDS_REVIEW", reasonCode: "MISSING_PO" });

    const bundle = await request(app).post("/api/runs").field("fixtureId", "bundle_unknown").expect(201);
    const awaitingBundle = await waitForRun(app, bundle.body.runId);
    expect(
      (
        await request(app)
          .post(`/api/runs/${bundle.body.runId}/review`)
          .send({ action: "confirm_bundle", candidateId: awaitingBundle.body.bundleCandidates[0].id })
          .expect(200)
      ).body,
    ).toMatchObject({ state: "POSTED" });

    const rejectedBundle = await request(rejected.app).post("/api/runs").field("fixtureId", "bundle_unknown").expect(201);
    await waitForRun(rejected.app, rejectedBundle.body.runId);
    expect(
      (await request(rejected.app).post(`/api/runs/${rejectedBundle.body.runId}/review`).send({ action: "reject_bundle" }).expect(200)).body,
    ).toMatchObject({ state: "NEEDS_REVIEW", reasonCode: "BUNDLE_MAPPING_REQUIRED" });
    storage.close();
    rejected.storage.close();
  });

  it("strictly validates payloads, candidates, and run state", async () => {
    const { app, storage } = setup();
    const missingPo = await request(app).post("/api/runs").field("fixtureId", "missing_po").expect(201);
    await waitForRun(app, missingPo.body.runId);

    await request(app).post(`/api/runs/${missingPo.body.runId}/review`).send({ action: "reject_po", extra: true }).expect(400);
    await request(app).post(`/api/runs/${missingPo.body.runId}/review`).send({ action: "confirm_po" }).expect(400);
    await request(app).post(`/api/runs/${missingPo.body.runId}/review`).send({ action: "confirm_po", poNumber: "not-a-candidate" }).expect(400);

    const runId = "11111111-1111-4111-8111-111111111111";
    storage.createRun({ id: runId, filename: "pending.pdf", sha256: "test", pdfPath: "pending.pdf" });
    const response = await request(app)
      .post(`/api/runs/${runId}/review`)
      .send({ action: "confirm_po", poNumber: "PO-1001" })
      .expect(409);
    expect(response.body.error).toMatchObject({ code: "INVALID_RUN_STATE", runId });
    storage.close();
  });
});

describe("removed routes", () => {
  it.each(["process", "confirm-po", "reject-po", "confirm-bundle", "reject-bundle"])("returns 404 for %s", async (route) => {
    const { app, storage } = setup();
    await request(app).post(`/api/runs/11111111-1111-4111-8111-111111111111/${route}`).send({}).expect(404);
    storage.close();
  });
});

describe("background failures", () => {
  it("persists unexpected processing failures without an unhandled rejection", async () => {
    class BrokenPdfStorage extends Storage {
      override getPdfPath() {
        return null;
      }
    }

    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-background-failure-"));
    temporaryDirectories.push(runtime);
    const storage = new BrokenPdfStorage(runtime);
    const app = createApp({ storage });
    const created = await request(app).post("/api/runs").field("fixtureId", "happy").expect(201);

    expect((await waitForRun(app, created.body.runId)).body).toMatchObject({
      state: "NEEDS_REVIEW",
      reasonCode: "PROCESSING_ERROR",
      execution: "BLOCKED",
    });
    storage.close();
  });

  it("blocks reset while a background run is active", async () => {
    const { app, storage } = setup("zamp-active-reset-");
    await request(app).post("/api/runs").field("fixtureId", "happy").expect(201);
    await request(app).post("/api/reset").expect(409);
    storage.close();
  });
});
