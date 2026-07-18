import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import { env } from "./env.js";
import { createApi, error, IntakeError } from "./routes.js";
import type { Storage } from "./storage.js";

export function createApp(options: { clientDirectory?: string; storage?: Storage } = {}) {
  const app = express();

  // Hide Express's X-Powered-By header so responses do not advertise the server framework.
  app.disable("x-powered-by");

  // Reuse a valid caller-supplied request ID, or create one for tracing logs and error responses.
  app.use((request, response, next) => {
    const supplied = request.get("X-Correlation-ID");
    const correlationId = supplied && /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : randomUUID();
    response.locals.correlationId = correlationId;
    response.set("X-Correlation-ID", correlationId);
    next();
  });

  // Add security headers and restrict scripts, styles, fonts, images, workers, and connections to approved sources.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "blob:"],
          workerSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          frameSrc: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-origin" },
    }),
  );

  if (env.NODE_ENV === "development") app.use(cors({ origin: env.DEV_CORS_ORIGIN, methods: ["GET", "POST"] }));

  app.use(express.json({ limit: "100kb" }));

  // Calls the required APIs'
  app.use("/api", createApi(options.storage));

  // Send static files for the page
  if (options.clientDirectory) {
    const clientDirectory = options.clientDirectory;
    app.use(express.static(clientDirectory));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
      response.sendFile(path.join(clientDirectory, "index.html"));
    });
  }

  // Convert known upload, parsing, domain, and run-state failures into stable HTTP error responses.
  app.use((err: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    // The parameter keeps Express's four-argument error-handler signature; void marks it intentionally unused.
    void next;
    // MulterError is thrown by multipart uploads, including file-size and malformed-upload failures.
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return response.status(413).json(error("UPLOAD_TOO_LARGE", "The PDF must be 10 MiB or smaller."));
    }

    if (err instanceof IntakeError) {
      return response.status(400).json(error("INVALID_PDF", err.message));
    }

    if (err instanceof multer.MulterError || (err instanceof SyntaxError && "body" in err))
      return response.status(400).json(error("INVALID_REQUEST", "The request is invalid."));

    if (err instanceof Error && err.message === "RUN_NOT_FOUND") {
      return response.status(404).json(error("RUN_NOT_FOUND", "Run not found."));
    }

    if (err instanceof Error && ["INVALID_RUN_STATE", "INVALID_CONFIRMATION", "RUN_EVALUATION_NOT_FOUND"].includes(err.message)) {
      return response
        .status(err.message === "INVALID_RUN_STATE" ? 409 : 400)
        .json(error(err.message, "The requested run action is not valid.", validRunIdFromRequest(_request)));
    }

    if (env.NODE_ENV === "development") console.error("[request]", response.locals.correlationId, safeServerError(err));

    return response
      .status(500)
      .json(
        error(
          "UNEXPECTED_ERROR",
          `The request could not be completed. Reference ${response.locals.correlationId}.`,
          validRunIdFromRequest(_request),
        ),
      );
  });

  app.use((_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Resource not found" } });
  });

  return app;
}

function validRunIdFromRequest(request: express.Request) {
  const value = request.params.runId ?? request.originalUrl.match(/\/runs\/([0-9a-f-]{36})/i)?.[1];
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

function safeServerError(error: unknown) {
  if (!(error instanceof Error)) return { type: typeof error };
  return { name: error.name, message: error.message };
}
