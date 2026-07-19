/**
 * Manual pipeline playground.
 *
 * Run one stage at a time:
 *   npm run pipeline:workbook -- --fixture happy --step extract
 *   npm run pipeline:workbook -- --fixture happy --step normalize
 *   npm run pipeline:workbook -- --fixture happy --step controls
 *   npm run pipeline:workbook -- --fixture happy --step run
 *   npm run pipeline:workbook -- --fixture missing_po --step run --confirm PO-1002
 *   npm run pipeline:workbook -- --file data/fixtures/02-Invoice-2.pdf --step run
 *
 * Available fixtures: happy, duplicate, missing_po, missing_po_bundle, bundle_known,
 * bundle_unknown, receipt_capacity, tax_inclusive.
 *
 * `run` uses tmp/pipeline-workbook, never data/runtime.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ControlError, evaluateInvoice } from "../server/src/controls.js";
import { normalizeInvoice } from "../server/src/invoice-normalization.js";
import { extractAndMapLive } from "../server/src/providers.js";
import { confirmBundle, confirmPo, processInvoice } from "../server/src/pipeline.js";
import { Storage } from "../server/src/storage.js";

const fixture = argument("--fixture");
const file = argument("--file");
const step = argument("--step") ?? "all";
const confirmation = argument("--confirm");
if (fixture && file) throw new Error("Choose either --fixture or --file.");
const fixturePath = path.resolve(file ?? `data/fixtures/${fixture ?? "happy"}.pdf`);

if (!new Set(["extract", "normalize", "controls", "run", "all"]).has(step)) {
  throw new Error("--step must be extract, normalize, controls, run, or all.");
}

const pdf = await readFile(fixturePath);
const extracted = step === "run" ? null : await extractAndMapLive(pdf);

if (extracted && (step === "extract" || step === "all")) print("1. extraction + mapping", extracted);

let invoice;
try {
  if (extracted) {
    invoice = normalizeInvoice(extracted.evidence, extracted.mapping);
    if (step === "normalize" || step === "all") print("2. normalization", invoice);
  }
} catch (error) {
  print("2. normalization failed", error);
  process.exitCode = 1;
}

if (invoice && (step === "controls" || step === "all")) {
  const storage = new Storage(path.resolve("tmp/pipeline-workbook/controls"));
  try {
    print("3. controls", evaluateInvoice(invoice, storage.getControlContext()));
  } catch (error) {
    print("3. controls failed", error);
    process.exitCode = 1;
  } finally {
    storage.close();
  }
}

if (step === "run" || step === "all") {
  const runId = randomUUID();
  const storage = new Storage(path.resolve(`tmp/pipeline-workbook/run-${runId}`));
  storage.createRun({
    id: runId,
    filename: path.basename(fixturePath),
    sha256: createHash("sha256").update(pdf).digest("hex"),
    pdfPath: fixturePath,
  });
  try {
    let result = await processInvoice(runId, storage, extractAndMapLive);
    print("4. stateful pipeline", result);
    if (confirmation && result.state === "AWAITING_PO_CONFIRMATION") {
      result = confirmPo(runId, storage, confirmation);
      print("5. PO confirmation", result);
    }
    if (confirmation && result.state === "AWAITING_BUNDLE_CONFIRMATION") {
      result = confirmBundle(runId, storage, confirmation);
      print("5. bundle confirmation", result);
    }
  } finally {
    storage.close();
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function print(label: string, value: unknown) {
  if (value instanceof ControlError) {
    console.log(`\n${label}`);
    console.log(JSON.stringify({ code: value.code, checks: value.checks }, null, 2));
    return;
  }
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}
