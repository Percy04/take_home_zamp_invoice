import express from "express";
import path from "node:path";
import { api } from "./routes.js";

export function createApp(clientDirectory?: string) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use("/api", api);

  if (clientDirectory) {
    app.use(express.static(clientDirectory));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
      response.sendFile(path.join(clientDirectory, "index.html"));
    });
  }

  app.use((_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Resource not found" } });
  });

  return app;
}
