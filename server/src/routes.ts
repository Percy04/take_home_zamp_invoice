import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { runStateSchema } from "../../shared/contracts.js";
import { env } from "./env.js";
import {
  confirmBundle,
  confirmPo,
  processInvoice,
  rejectPo,
} from "./pipeline.js";
import type { Storage } from "./storage.js";

const maxPdfBytes = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: maxPdfBytes },
});
const fixtureIds = new Set([
  "happy",
  "duplicate",
  "missing_po",
  "receipt_capacity",
  "happy_layout_b",
  "happy_layout_c_scanned",
  "bundle_known",
  "bundle_unknown",
  "tax_inclusive",
]);

export function createApi(storage?: Storage) {
  const api = Router();
  const processingRuns = new Set<string>();
  const writeLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  api.get("/health", (_request, response) => {
    try {
      if (storage) storage.ping();
      response.json({
        status: "ok",
        database: storage ? "available" : "not-initialized",
      });
    } catch {
      response
        .status(503)
        .json({ status: "not-ready", database: "unavailable" });
    }
  });

  if (!storage) return api;

  api.get("/runs", (request, response) => {
    const parsed = z
      .object({
        state: runStateSchema.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().min(1).optional(),
      })
      .strict()
      .safeParse(request.query);
    if (!parsed.success)
      return response
        .status(400)
        .json(error("INVALID_QUERY", "Run filters are invalid."));
    try {
      response.json(storage.listRuns(parsed.data));
    } catch (caught) {
      if (caught instanceof Error && caught.message === "INVALID_CURSOR")
        return response
          .status(400)
          .json(error("INVALID_CURSOR", "The pagination cursor is invalid."));
      throw caught;
    }
  });

  api.post(
    "/runs",
    writeLimit,
    upload.single("invoice"),
    async (request, response, next) => {
      try {
        const idempotencyKey = request.get("Idempotency-Key")?.trim();
        if (idempotencyKey && idempotencyKey.length > 200)
          return response
            .status(400)
            .json(
              error("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key is too long."),
            );
        if (idempotencyKey) {
          const existing = storage.getRunByIdempotencyKey(idempotencyKey);
          if (existing)
            return response
              .location(`/api/runs/${existing.runId}`)
              .status(200)
              .json(existing);
        }
        const fixtureId =
          typeof request.body.fixtureId === "string"
            ? request.body.fixtureId
            : undefined;
        if (Boolean(request.file) === Boolean(fixtureId)) {
          return response
            .status(400)
            .json(error("INVALID_UPLOAD", "Choose one PDF or fixture."));
        }
        if (fixtureId && !fixtureIds.has(fixtureId)) {
          return response
            .status(400)
            .json(error("INVALID_FIXTURE", "Unknown fixture."));
        }
        const bytes = request.file
          ? request.file.buffer
          : await readFile(path.resolve(`data/fixtures/${fixtureId}.pdf`));
        const filename = request.file?.originalname ?? `${fixtureId}.pdf`;
        if (request.file && request.file.mimetype !== "application/pdf") {
          return response
            .status(400)
            .json(error("INVALID_PDF", "The upload must be a PDF."));
        }
        await validatePdf(bytes);
        const runId = randomUUID();
        const uploadDirectory = path.join(storage.runtimeDirectory, "uploads");
        await mkdir(uploadDirectory, { recursive: true });
        const pdfPath = path.join(uploadDirectory, `${runId}.pdf`);
        await writeFile(pdfPath, bytes);
        const run = storage.createRun({
          id: runId,
          filename,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          pdfPath,
          idempotencyKey,
        });
        response.location(`/api/runs/${runId}`).status(201).json(run);
      } catch (caught) {
        next(caught);
      }
    },
  );

  api.post(
    "/runs/:runId/process",
    writeLimit,
    async (request, response, next) => {
      try {
        const runId = validRunId(request.params.runId);
        if (!runId)
          return response
            .status(400)
            .json(error("INVALID_RUN_ID", "Run ID is invalid."));
        if (!emptyBody(request.body))
          return response
            .status(400)
            .json(
              error(
                "INVALID_BODY",
                "This action accepts no request body.",
                runId,
              ),
            );
        const run = storage.getRun(runId);
        if (!run)
          return response
            .status(404)
            .json(error("RUN_NOT_FOUND", "Run not found."));
        if (processingRuns.has(runId)) return response.status(202).json(run);
        processingRuns.add(runId);
        try {
          response.json(await processInvoice(runId, storage));
        } finally {
          processingRuns.delete(runId);
        }
      } catch (caught) {
        next(caught);
      }
    },
  );

  api.post(
    "/runs/:runId/confirm-po",
    writeLimit,
    async (request, response, next) => {
      try {
        const runId = validRunId(request.params.runId);
        if (!runId)
          return response
            .status(400)
            .json(error("INVALID_RUN_ID", "Run ID is invalid."));
        const body = z
          .object({ poNumber: z.string().trim().min(1) })
          .strict()
          .safeParse(request.body);
        if (!body.success)
          return response
            .status(400)
            .json(
              error(
                "INVALID_CONFIRMATION",
                "Provide exactly one PO candidate.",
                runId,
              ),
            );
        const run = storage.getRun(runId);
        if (!run)
          return response
            .status(404)
            .json(error("RUN_NOT_FOUND", "Run not found."));
        response.json(confirmPo(runId, storage, body.data.poNumber));
      } catch (caught) {
        next(caught);
      }
    },
  );

  api.post("/runs/:runId/reject-po", writeLimit, (request, response, next) => {
    try {
      const runId = validRunId(request.params.runId);
      if (!runId)
        return response
          .status(400)
          .json(error("INVALID_RUN_ID", "Run ID is invalid."));
      if (!emptyBody(request.body))
        return response
          .status(400)
          .json(
            error(
              "INVALID_BODY",
              "This action accepts no request body.",
              runId,
            ),
          );
      response.json(rejectPo(runId, storage));
    } catch (caught) {
      next(caught);
    }
  });

  api.post(
    "/runs/:runId/confirm-bundle",
    writeLimit,
    async (request, response, next) => {
      try {
        const runId = validRunId(request.params.runId);
        if (!runId)
          return response
            .status(400)
            .json(error("INVALID_RUN_ID", "Run ID is invalid."));
        const body = z
          .object({ candidateId: z.string().trim().min(1) })
          .strict()
          .safeParse(request.body);
        if (!body.success)
          return response
            .status(400)
            .json(
              error(
                "INVALID_CONFIRMATION",
                "Provide exactly one bundle candidate.",
                runId,
              ),
            );
        const run = storage.getRun(runId);
        if (!run)
          return response
            .status(404)
            .json(error("RUN_NOT_FOUND", "Run not found."));
        response.json(confirmBundle(runId, storage, body.data.candidateId));
      } catch (caught) {
        next(caught);
      }
    },
  );

  api.get("/runs/:runId", (request, response) => {
    const runId = validRunId(request.params.runId);
    if (!runId)
      return response
        .status(400)
        .json(error("INVALID_RUN_ID", "Run ID is invalid."));
    const run = storage.getRun(runId);
    if (!run)
      return response
        .status(404)
        .json(error("RUN_NOT_FOUND", "Run not found."));
    response.json(run);
  });

  api.get("/runs/:runId/document", (request, response) => {
    const runId = validRunId(request.params.runId);
    if (!runId)
      return response
        .status(400)
        .json(error("INVALID_RUN_ID", "Run ID is invalid."));
    const pdfPath = storage.getPdfPath(runId);
    if (!pdfPath)
      return response
        .status(404)
        .json(error("RUN_NOT_FOUND", "Run not found."));
    response.type("application/pdf").set({
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    });
    response.sendFile(path.resolve(pdfPath));
  });

  api.post("/reset", writeLimit, (request, response) => {
    if (!env.ALLOW_DEMO_RESET)
      return response
        .status(403)
        .json(error("RESET_DISABLED", "Demo reset is disabled."));
    if (!emptyBody(request.body))
      return response
        .status(400)
        .json(error("INVALID_BODY", "Reset accepts no request body."));
    if (processingRuns.size)
      return response
        .status(409)
        .json(
          error(
            "WRITE_IN_PROGRESS",
            "Reset is unavailable while a run is processing.",
          ),
        );
    storage.reset();
    response.json({ status: "reset" });
  });

  return api;
}

async function validatePdf(bytes: Buffer) {
  if (
    !bytes.length ||
    bytes.length > maxPdfBytes ||
    !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
  ) {
    throw new IntakeError("The file is not a supported PDF.");
  }
  try {
    const pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > 10)
      throw new IntakeError("PDFs must have 1–10 pages.");
  } catch (caught) {
    if (caught instanceof IntakeError) throw caught;
    throw new IntakeError("The PDF is malformed or encrypted.");
  }
}

export class IntakeError extends Error {}

export function error(code: string, message: string, runId?: string) {
  return { error: { code, message, ...(runId ? { runId } : {}) } };
}

function validRunId(value: string | string[] | undefined) {
  const parsed = z.uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function emptyBody(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "object" && Object.keys(value).length === 0)
  );
}
