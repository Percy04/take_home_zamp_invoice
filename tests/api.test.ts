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

    expect(listed.body).toMatchObject([
      {
        runId: created.body.runId,
        filename: "happy.pdf",
        state: "PROCESSING",
      },
    ]);
    storage.close();
  });
});
