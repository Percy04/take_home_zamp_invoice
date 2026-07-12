import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

type Fixture = {
  file: string;
  pdf_sha256: string;
  input: {
    vendor: string;
    invoice_number: string;
    invoice_date: string;
    po_number: string | null;
    currency: string;
    subtotal: string | null;
    tax: string | null;
    total: string;
    tax_note?: string;
    lines: Array<{
      sku: string;
      description: string;
      quantity: string;
      uom: string;
      unit_price: string;
      amount: string;
    }>;
  };
};

const root = process.cwd();
const output = path.resolve(process.argv[2] ?? "tmp/demo-data");
const cases = JSON.parse(
  await readFile(path.join(root, "data/cases.json"), "utf8"),
) as { fixtures: Record<string, Fixture>; [key: string]: unknown };

await mkdir(path.join(output, "fixtures"), { recursive: true });
await cp(path.join(root, "data/seed.sqlite"), path.join(output, "seed.sqlite"));
await cp(path.join(root, "data/recordings"), path.join(output, "recordings"), {
  recursive: true,
});

for (const [fixtureId, fixture] of Object.entries(cases.fixtures)) {
  const bytes =
    fixtureId === "happy_layout_c_scanned"
      ? await readFile(path.join(root, fixture.file))
      : await buildPdf(fixtureId, fixture);
  const filename = path.basename(fixture.file);
  await writeFile(path.join(output, "fixtures", filename), bytes);
  fixture.file = `data/fixtures/${filename}`;
  fixture.pdf_sha256 = createHash("sha256").update(bytes).digest("hex");
}

await writeFile(
  path.join(output, "cases.json"),
  `${JSON.stringify(cases, null, 2)}\n`,
);
console.log(`Deterministic demo data written to ${output}`);

async function buildPdf(fixtureId: string, fixture: Fixture) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Invoice ${fixture.input.invoice_number}`);
  pdf.setSubject("Synthetic AP demo fixture");
  pdf.setAuthor("AP Resolution Agent");
  pdf.setCreator("scripts/build-demo-data.ts");
  pdf.setProducer("pdf-lib");
  const fixed = new Date("2026-07-11T00:00:00.000Z");
  pdf.setCreationDate(fixed);
  pdf.setModificationDate(fixed);
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const alternate = fixtureId === "happy_layout_b";
  let y = 742;
  const draw = (label: string, value: string, emphasized = false) => {
    page.drawText(`${label}: ${value}`, {
      x: alternate ? 70 : 54,
      y,
      size: emphasized ? 14 : 10,
      font: emphasized ? bold : font,
      color: rgb(0.08, 0.12, 0.1),
    });
    y -= emphasized ? 28 : 18;
  };
  draw("INVOICE", fixture.input.invoice_number, true);
  draw("Vendor", fixture.input.vendor);
  draw("Date", fixture.input.invoice_date);
  if (fixture.input.po_number) draw("PO", fixture.input.po_number);
  draw("Currency", fixture.input.currency);
  y -= 10;
  fixture.input.lines.forEach((line, index) => {
    draw(
      `Line ${index + 1}`,
      `${line.sku} | ${line.description} | ${line.quantity} ${line.uom} x $${line.unit_price} = $${line.amount}`,
    );
  });
  y -= 10;
  if (fixture.input.subtotal) draw("Subtotal", `$${fixture.input.subtotal}`);
  if (fixture.input.tax) draw("Tax", `$${fixture.input.tax}`);
  draw("Total", `$${fixture.input.total}`, true);
  if (fixture.input.tax_note) draw("Tax note", fixture.input.tax_note);
  page.drawText("SYNTHETIC DEMO DATA ONLY", {
    x: 54,
    y: 38,
    size: 9,
    font: bold,
    color: rgb(0.45, 0.1, 0.1),
  });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
