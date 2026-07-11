import { Router } from "express";

export const api = Router();

api.get("/health", (_request, response) => {
  response.json({ status: "ok", database: "not-initialized" });
});
