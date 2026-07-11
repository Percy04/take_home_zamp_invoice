import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import { processInvoice } from "./pipeline.js";
import type { Storage } from "./storage.js";

const maxPdfBytes = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: maxPdfBytes },
});

export function createApi(storage?: Storage) {
  const api = Router();

  api.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      database: storage ? "available" : "not-initialized",
    });
  });

  if (!storage) return api;

  api.post(
    "/runs",
    upload.single("invoice"),
    async (request, response, next) => {
      try {
        const fixtureId =
          typeof request.body.fixtureId === "string"
            ? request.body.fixtureId
            : undefined;
        if (Boolean(request.file) === Boolean(fixtureId)) {
          return response
            .status(400)
            .json(error("INVALID_UPLOAD", "Choose one PDF or fixture."));
        }
        if (fixtureId && fixtureId !== "happy") {
          return response
            .status(400)
            .json(
              error("INVALID_FIXTURE", "Only the happy fixture is available."),
            );
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
        });
        response.location(`/api/runs/${runId}`).status(201).json(run);
      } catch (caught) {
        next(caught);
      }
    },
  );

  api.post("/runs/:runId/process", async (request, response, next) => {
    try {
      const run = storage.getRun(request.params.runId);
      if (!run)
        return response
          .status(404)
          .json(error("RUN_NOT_FOUND", "Run not found."));
      response.json(await processInvoice(request.params.runId, storage));
    } catch (caught) {
      next(caught);
    }
  });

  api.get("/runs/:runId", (request, response) => {
    const run = storage.getRun(request.params.runId);
    if (!run)
      return response
        .status(404)
        .json(error("RUN_NOT_FOUND", "Run not found."));
    response.json(run);
  });

  api.get("/runs/:runId/document", (request, response) => {
    const pdfPath = storage.getPdfPath(request.params.runId);
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

  api.post("/reset", (_request, response) => {
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

export function error(code: string, message: string) {
  return { error: { code, message } };
}
