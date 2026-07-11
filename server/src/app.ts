import express from "express";
import path from "node:path";
import multer from "multer";
import { createApi, error, IntakeError } from "./routes.js";
import type { Storage } from "./storage.js";

export function createApp(
  options: { clientDirectory?: string; storage?: Storage } = {},
) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use("/api", createApi(options.storage));

  if (options.clientDirectory) {
    const clientDirectory = options.clientDirectory;
    app.use(express.static(clientDirectory));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/"))
        return next();
      response.sendFile(path.join(clientDirectory, "index.html"));
    });
  }

  app.use(
    (
      err: unknown,
      _request: express.Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      void next;
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return response
          .status(413)
          .json(
            error("UPLOAD_TOO_LARGE", "The PDF must be 10 MiB or smaller."),
          );
      }

      if (err instanceof IntakeError) {
        return response.status(400).json(error("INVALID_PDF", err.message));
      }

      console.error(err);

      return response
        .status(500)
        .json(error("UNEXPECTED_ERROR", "The request could not be completed."));
    },
  );

  app.use((_request, response) => {
    response
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Resource not found" } });
  });

  return app;
}
