import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/src/app.js";
import { Storage } from "../server/src/storage.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true });
});

describe("GET /api/health", () => {
  it("reports that the application is ready", async () => {
    const response = await request(createApp()).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      database: "not-initialized",
    });
  });
});

describe("GET /api/runs", () => {
  it("lists recent runs", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-api-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });

    const created = await request(app)
      .post("/api/runs")
      .field("fixtureId", "happy")
      .expect(201);
    const listed = await request(app).get("/api/runs").expect(200);

    expect(listed.body).toMatchObject({
      items: [
        {
          runId: created.body.runId,
          filename: "happy.pdf",
          state: "PROCESSING",
        },
      ],
      nextCursor: null,
      metrics: { totalRuns: 1 },
    });
    storage.close();
  });
});

describe("confirmation errors", () => {
  it("returns a client error when the run is not awaiting confirmation", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-api-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });

    const created = await request(app)
      .post("/api/runs")
      .field("fixtureId", "happy")
      .expect(201);
    const response = await request(app)
      .post(`/api/runs/${created.body.runId}/confirm-po`)
      .send({ poNumber: "PO-1001" })
      .expect(409);

    expect(response.body).toMatchObject({
      error: {
        code: "INVALID_RUN_STATE",
        message: "The requested run action is not valid.",
        runId: created.body.runId,
      },
    });
    storage.close();
  });
});

describe("API hardening", () => {
  it("reuses an Idempotency-Key and paginates with state filters", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-api-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });

    const first = await request(app)
      .post("/api/runs")
      .set("Idempotency-Key", "same-upload")
      .field("fixtureId", "happy")
      .expect(201);
    const retried = await request(app)
      .post("/api/runs")
      .set("Idempotency-Key", "same-upload")
      .field("fixtureId", "duplicate")
      .expect(200);
    await request(app).post("/api/runs").field("fixtureId", "duplicate").expect(201);

    expect(retried.body.runId).toBe(first.body.runId);
    const page = await request(app)
      .get("/api/runs?state=PROCESSING&limit=1")
      .expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toEqual(expect.any(String));
    const next = await request(app)
      .get(`/api/runs?state=PROCESSING&limit=1&cursor=${page.body.nextCursor}`)
      .expect(200);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].runId).not.toBe(page.body.items[0].runId);
    storage.close();
  });

  it("rejects extra action fields and sends safe security metadata", async () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "zamp-api-"));
    temporaryDirectories.push(runtime);
    const storage = new Storage(runtime);
    const app = createApp({ storage });
    const created = await request(app)
      .post("/api/runs")
      .field("fixtureId", "happy")
      .expect(201);

    const response = await request(app)
      .post(`/api/runs/${created.body.runId}/confirm-po`)
      .send({ poNumber: "PO-1001", approve: true })
      .expect(400);
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-correlation-id"]).toEqual(expect.any(String));
    expect(response.body.error.code).toBe("INVALID_CONFIRMATION");
    storage.close();
  });
});
