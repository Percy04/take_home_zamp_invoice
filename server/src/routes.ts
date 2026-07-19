import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { env } from "./env.js";
import { confirmBundle, confirmPo, processInvoice, rejectBundle, rejectPo } from "./pipeline.js";
import type { InvoiceExtractor } from "./providers.js";
import type { Storage } from "./storage.js";

const maxPdfBytes = 10 * 1024 * 1024;

// Configure Multer to keep one uploaded file in memory and reject files larger than 10 MiB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: maxPdfBytes },
});

const reviewActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm_po"), poNumber: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal("reject_po") }).strict(),
  z.object({ action: z.literal("confirm_bundle"), candidateId: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal("reject_bundle") }).strict(),
]);

// Build the API router and attach all run-management endpoints to it.
export function createApi({ storage, extractInvoice }: { storage?: Storage; extractInvoice?: InvoiceExtractor } = {}) {
  const api = Router();

  // Track runs currently being processed so the same run cannot be processed twice at once.
  const processingRuns = new Set<string>();

  function launchProcessing(runId: string) {
    if (processingRuns.has(runId) || storage?.getRun(runId)?.state !== "PROCESSING") return;
    processingRuns.add(runId);
    void (async () => {
      try {
        await processInvoice(runId, storage!, extractInvoice);
      } catch {
        try {
          if (storage!.getRun(runId)?.state === "PROCESSING") {
            storage!.addStage(runId, "PROCESSING", "FAILED");
            storage!.block(runId, "PROCESSING_ERROR", "Retry; if it repeats, inspect application diagnostics without reposting.");
          }
        } catch {
          // A storage failure cannot be persisted, but it must not become an unhandled rejection.
        }
      } finally {
        processingRuns.delete(runId);
      }
    })();
  }

  // Limit write operations to 30 requests per minute.
  const writeLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  // Report whether the API is alive and whether its storage layer can be reached.
  api.get("/health", (_request, response) => {
    try {
      if (storage) storage.ping();
      response.json({
        status: "ok",
        database: storage ? "available" : "not-initialized",
      });
    } catch {
      response.status(503).json({ status: "not-ready", database: "unavailable" });
    }
  });

  // The health endpoint works without storage; all remaining endpoints require it.
  if (!storage) return api;

  // Return every stored run, newest first.
  api.get("/runs", (request, response) => {
    const parsed = z.object({}).strict().safeParse(request.query);

    if (!parsed.success) 
      return response.status(400).json(error("INVALID_QUERY", "Run filters are invalid."));

    return response.json(storage.listRuns());
  });

  // Accept one PDF upload, validate it, save it, and create a run record.
  api.post("/runs", writeLimit, upload.single("invoice"), async (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json(error("INVALID_UPLOAD", "Attach one invoice PDF."));

      // Return an existing run when the caller repeats a request with the same idempotency key.
      const idempotencyKey = request.get("Idempotency-Key")?.trim();
      if (idempotencyKey && idempotencyKey.length > 200)
        return response.status(400).json(error("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key is too long."));

      if (idempotencyKey) {
        const existing = storage.getRunByIdempotencyKey(idempotencyKey);
        if (existing) {
          launchProcessing(existing.runId);
          return response.location(`/api/runs/${existing.runId}`).status(200).json(existing);
        }
      }

      const { buffer: bytes, originalname: filename } = request.file;

      // Check the declared MIME type before doing deeper PDF validation.
      if (request.file.mimetype !== "application/pdf") {
        return response.status(400).json(error("INVALID_PDF", "The upload must be a PDF."));
      }

      // Verify the file header, PDF structure, encryption state, and page count.
      await validatePdf(bytes);

      // Save the PDF under a generated ID and persist metadata about the new run.
      const runId = randomUUID();
      const uploadDirectory = path.join(storage.runtimeDirectory, "uploads");

      await mkdir(uploadDirectory, { recursive: true });

      const pdfPath = path.join(uploadDirectory, `${runId}.pdf`);

      await writeFile(pdfPath, bytes);

      // Persist run in storage
      const run = storage.createRun({
        id: runId,
        filename,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        pdfPath,
        idempotencyKey,
      });

      // Start processing
      launchProcessing(runId);

      // return location
      return response.location(`/api/runs/${runId}`).status(201).json(run);
    } catch (caught) {
      next(caught);
    }
  });

  // Apply the selected review decision to an awaiting run.
  api.post("/runs/:runId/review", writeLimit, (request, response, next) => {
    try {
      const runId = validRunId(request.params.runId);
      if (!runId) 
        return response.status(400).json(error("INVALID_RUN_ID", "Run ID is invalid."));

      const action = reviewActionSchema.safeParse(request.body);
      if (!action.success) 
        return response.status(400).json(error("INVALID_REVIEW", "Provide a valid review action.", runId));

      switch (action.data.action) {
        case "confirm_po":
          return response.json(confirmPo(runId, storage, action.data.poNumber));
        case "reject_po":
          return response.json(rejectPo(runId, storage));
        case "confirm_bundle":
          return response.json(confirmBundle(runId, storage, action.data.candidateId));
        case "reject_bundle":
          return response.json(rejectBundle(runId, storage));
      }
    } catch (caught) {
      next(caught);
    }
  });

  // Return the current state and metadata for one run.
  api.get("/runs/:runId", (request, response) => {
    const runId = validRunId(request.params.runId);
    if (!runId) return response.status(400).json(error("INVALID_RUN_ID", "Run ID is invalid."));
    const run = storage.getRun(runId);
    if (!run) return response.status(404).json(error("RUN_NOT_FOUND", "Run not found."));
    response.json(run);
  });

  // Stream the stored PDF for a run back to the client.
  api.get("/runs/:runId/document", (request, response) => {
    const runId = validRunId(request.params.runId);
    if (!runId) 
      return response.status(400).json(error("INVALID_RUN_ID", "Run ID is invalid."));

    const pdfPath = storage.getPdfPath(runId);
    if (!pdfPath) 
      return response.status(404).json(error("RUN_NOT_FOUND", "Run not found."));

    response.type("application/pdf").set({
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    });

    return response.sendFile(path.resolve(pdfPath));
  });

  // Reset demo data when explicitly enabled and no run is currently processing.
  api.post("/reset", writeLimit, (request, response) => {
    if (!env.ALLOW_DEMO_RESET) return response.status(403).json(error("RESET_DISABLED", "Demo reset is disabled."));
    if (!emptyBody(request.body)) return response.status(400).json(error("INVALID_BODY", "Reset accepts no request body."));
    if (processingRuns.size)
      return response.status(409).json(error("WRITE_IN_PROGRESS", "Reset is unavailable while a run is processing."));
    storage.reset();
    response.json({ status: "reset" });
  });

  // Return the completed router to the Express application.
  return api;
}

// Validate the uploaded PDF bytes and enforce the supported page-count range.
async function validatePdf(bytes: Buffer) {
  if (!bytes.length || bytes.length > maxPdfBytes || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new IntakeError("The file is not a supported PDF.");
  }
  try {
    const pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > 10) throw new IntakeError("PDFs must have 1–10 pages.");
  } catch (caught) {
    if (caught instanceof IntakeError) throw caught;
    throw new IntakeError("The PDF is malformed or encrypted.");
  }
}

// Error type used when an uploaded document fails intake validation.
export class IntakeError extends Error {}

// Create the consistent error response shape used by all API endpoints.
export function error(code: string, message: string, runId?: string) {
  return { error: { code, message, ...(runId ? { runId } : {}) } };
}

// Accept only valid UUID run IDs and return null for invalid route parameters.
function validRunId(value: string | string[] | undefined) {
  const parsed = z.uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Treat missing, null, or empty objects as requests with no body.
function emptyBody(value: unknown) {
  return value === undefined || value === null || (typeof value === "object" && Object.keys(value).length === 0);
}
