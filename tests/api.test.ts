import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/src/app.js";

describe("GET /api/health", () => {
  it("reports that the application is ready", async () => {
    const response = await request(createApp()).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", database: "not-initialized" });
  });
});
