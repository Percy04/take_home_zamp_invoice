"""Build deterministic PDFs, seed data, and acceptance cases for the AP demo."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from decimal import Decimal
from pathlib import Path

from pypdf import PdfReader
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
FIXTURE_DIR = DATA_DIR / "fixtures"
SEED_PATH = DATA_DIR / "seed.sqlite"
CASES_PATH = DATA_DIR / "cases.json"


FIXTURES = {
    "happy": {
        "vendor": "Acme Industrial Supplies LLC",
        "address": ["123 Foundry Road", "Bengaluru, KA 560001"],
        "invoice_number": "ACME-2026-001",
        "invoice_date": "2026-07-01",
        "po_number": "PO-1001",
        "currency": "USD",
        "lines": [
            {
                "sku": "WID-100",
                "description": "Industrial Widget",
                "quantity": "8",
                "uom": "EA",
                "unit_price": "100.00",
                "amount": "800.00",
            },
            {
                "sku": "BOL-200",
                "description": "Mounting Bolt Pack",
                "quantity": "5",
                "uom": "EA",
                "unit_price": "20.00",
                "amount": "100.00",
            },
        ],
        "subtotal": "900.00",
        "tax": "90.00",
        "total": "990.00",
    },
    "duplicate": {
        "vendor": "Acme Industrial Supplies LLC",
        "address": ["123 Foundry Road", "Bengaluru, KA 560001"],
        "invoice_number": "ACME-2026-000",
        "invoice_date": "2026-06-01",
        "po_number": "PO-0999",
        "currency": "USD",
        "lines": [
            {
                "sku": "FIL-900",
                "description": "Replacement Filter",
                "quantity": "1",
                "uom": "EA",
                "unit_price": "100.00",
                "amount": "100.00",
            }
        ],
        "subtotal": "100.00",
        "tax": "10.00",
        "total": "110.00",
    },
    "missing_po": {
        "vendor": "Acme Industrial Supplies LLC",
        "address": ["123 Foundry Road", "Bengaluru, KA 560001"],
        "invoice_number": "ACME-2026-002",
        "invoice_date": "2026-07-02",
        "po_number": None,
        "currency": "USD",
        "lines": [
            {
                "sku": "SEN-300",
                "description": "Safety Sensor",
                "quantity": "2",
                "uom": "EA",
                "unit_price": "251.00",
                "amount": "502.00",
            }
        ],
        "subtotal": "502.00",
        "tax": "50.20",
        "total": "552.20",
    },
    "receipt_capacity": {
        "vendor": "Delta Components Ltd",
        "address": ["45 Assembly Avenue", "Pune, MH 411001"],
        "invoice_number": "DELTA-2026-010",
        "invoice_date": "2026-07-03",
        "po_number": "PO-2001",
        "currency": "USD",
        "lines": [
            {
                "sku": "VAL-500",
                "description": "Control Valve",
                "quantity": "3",
                "uom": "EA",
                "unit_price": "50.00",
                "amount": "150.00",
            }
        ],
        "subtotal": "150.00",
        "tax": "15.00",
        "total": "165.00",
    },
}


def normalize_match_key(value: str) -> str:
    return "".join(character for character in value.upper() if character.isalnum())


def pdf_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def money(value: str) -> str:
    return f"${Decimal(value):,.2f}"


def assert_invoice_math(invoice: dict) -> None:
    line_total = Decimal("0")
    for line in invoice["lines"]:
        assert Decimal(line["quantity"]) * Decimal(line["unit_price"]) == Decimal(
            line["amount"]
        )
        line_total += Decimal(line["amount"])
    assert line_total == Decimal(invoice["subtotal"])
    assert line_total + Decimal(invoice["tax"]) == Decimal(invoice["total"])


def build_pdf(path: Path, invoice: dict) -> None:
    assert_invoice_math(invoice)
    document = canvas.Canvas(
        str(path), pagesize=letter, pageCompression=1, invariant=1
    )
    width, height = letter
    document.setTitle(f"Invoice {invoice['invoice_number']}")
    document.setAuthor(invoice["vendor"])
    document.setCreator("Zamp AP Resolution Agent demo data")

    document.setFont("Helvetica-Bold", 18)
    document.drawString(54, height - 58, invoice["vendor"])
    document.setFont("Helvetica-Bold", 24)
    document.drawRightString(width - 54, height - 58, "INVOICE")

    document.setFont("Helvetica", 9)
    for index, address_line in enumerate(invoice["address"]):
        document.drawString(54, height - 76 - index * 12, address_line)

    label_x, value_x = 340, 440
    details = [
        ("Invoice Number", invoice["invoice_number"]),
        ("Invoice Date", invoice["invoice_date"]),
        ("Currency", invoice["currency"]),
    ]
    if invoice["po_number"]:
        details.append(("Purchase Order", invoice["po_number"]))
    for index, (label, value) in enumerate(details):
        y = height - 84 - index * 16
        document.setFont("Helvetica-Bold", 9)
        document.drawString(label_x, y, f"{label}:")
        document.setFont("Helvetica", 9)
        document.drawString(value_x, y, value)

    document.setFont("Helvetica-Bold", 9)
    document.drawString(54, height - 145, "BILL TO")
    document.setFont("Helvetica", 9)
    document.drawString(54, height - 160, "Zamp Demo Company")
    document.drawString(54, height - 172, "Accounts Payable")
    document.drawString(54, height - 184, "Bengaluru, India")

    table_top = height - 225
    document.setFillColorRGB(0.12, 0.22, 0.35)
    document.rect(54, table_top - 18, width - 108, 18, fill=1, stroke=0)
    document.setFillColorRGB(1, 1, 1)
    document.setFont("Helvetica-Bold", 8)
    document.drawString(60, table_top - 12, "SKU")
    document.drawString(122, table_top - 12, "DESCRIPTION")
    document.drawRightString(345, table_top - 12, "QTY")
    document.drawString(360, table_top - 12, "UOM")
    document.drawRightString(470, table_top - 12, "UNIT PRICE")
    document.drawRightString(width - 60, table_top - 12, "AMOUNT")

    y = table_top - 39
    document.setFillColorRGB(0, 0, 0)
    for line in invoice["lines"]:
        document.setFont("Helvetica", 8)
        document.drawString(60, y, line["sku"])
        document.drawString(122, y, line["description"])
        document.drawRightString(345, y, line["quantity"])
        document.drawString(360, y, line["uom"])
        document.drawRightString(470, y, money(line["unit_price"]))
        document.drawRightString(width - 60, y, money(line["amount"]))
        document.setStrokeColorRGB(0.82, 0.84, 0.86)
        document.line(54, y - 8, width - 54, y - 8)
        y -= 25

    totals_y = y - 12
    for label, value in (
        ("Subtotal", invoice["subtotal"]),
        ("Tax", invoice["tax"]),
    ):
        document.setFont("Helvetica", 9)
        document.drawRightString(470, totals_y, label)
        document.drawRightString(width - 60, totals_y, money(value))
        totals_y -= 17
    document.setFont("Helvetica-Bold", 11)
    document.drawRightString(470, totals_y, "TOTAL")
    document.drawRightString(width - 60, totals_y, money(invoice["total"]))

    document.setFont("Helvetica", 8)
    document.setFillColorRGB(0.35, 0.35, 0.35)
    document.drawCentredString(
        width / 2, 40, "Synthetic demo invoice - no payment is due."
    )
    document.showPage()
    document.save()


def build_database(path: Path) -> None:
    if path.exists():
        path.unlink()

    connection = sqlite3.connect(path)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = DELETE")
    connection.execute("PRAGMA page_size = 4096")
    connection.executescript(
        """
        CREATE TABLE vendors (
            id TEXT PRIMARY KEY,
            canonical_name TEXT NOT NULL UNIQUE,
            normalized_name TEXT NOT NULL UNIQUE,
            aliases_json TEXT NOT NULL,
            active INTEGER NOT NULL CHECK (active IN (0, 1))
        );

        CREATE TABLE purchase_orders (
            po_number TEXT PRIMARY KEY,
            normalized_po_number TEXT NOT NULL UNIQUE,
            vendor_id TEXT NOT NULL REFERENCES vendors(id),
            currency TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED'))
        );

        CREATE TABLE po_lines (
            id TEXT PRIMARY KEY,
            po_number TEXT NOT NULL REFERENCES purchase_orders(po_number),
            line_number INTEGER NOT NULL,
            sku TEXT,
            normalized_sku TEXT,
            description TEXT NOT NULL,
            normalized_description TEXT NOT NULL,
            uom TEXT NOT NULL,
            ordered_quantity TEXT NOT NULL,
            received_quantity TEXT NOT NULL,
            unit_price TEXT NOT NULL,
            UNIQUE (po_number, line_number)
        );

        CREATE TABLE runs (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_sha256 TEXT NOT NULL,
            pdf_path TEXT,
            state TEXT NOT NULL CHECK (
                state IN ('PROCESSING', 'AWAITING_PO_CONFIRMATION', 'POSTED', 'NEEDS_REVIEW')
            ),
            decision TEXT CHECK (decision IN ('AUTO_CLEARED', 'NEEDS_REVIEW')),
            execution TEXT CHECK (execution IN ('POSTED', 'BLOCKED', 'AWAITING_CONFIRMATION')),
            vendor_id TEXT REFERENCES vendors(id),
            normalized_invoice_number TEXT,
            selected_po_number TEXT REFERENCES purchase_orders(po_number),
            primary_reason_code TEXT,
            next_action TEXT,
            ledger_invoice_id TEXT,
            extraction_json TEXT,
            mapping_json TEXT,
            evaluation_json TEXT,
            candidates_json TEXT,
            stage_events_json TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE posted_invoices (
            id TEXT PRIMARY KEY,
            run_id TEXT UNIQUE REFERENCES runs(id),
            origin TEXT NOT NULL CHECK (origin IN ('SEED', 'RUN')),
            vendor_id TEXT NOT NULL REFERENCES vendors(id),
            invoice_number TEXT NOT NULL,
            normalized_invoice_number TEXT NOT NULL,
            invoice_date TEXT NOT NULL,
            currency TEXT NOT NULL,
            subtotal TEXT NOT NULL,
            tax TEXT NOT NULL,
            total TEXT NOT NULL,
            po_number TEXT REFERENCES purchase_orders(po_number),
            posted_at TEXT NOT NULL,
            UNIQUE (vendor_id, normalized_invoice_number)
        );

        CREATE TABLE allocations (
            id TEXT PRIMARY KEY,
            posted_invoice_id TEXT NOT NULL REFERENCES posted_invoices(id),
            po_line_id TEXT NOT NULL REFERENCES po_lines(id),
            invoice_quantity TEXT NOT NULL,
            po_basis_amount TEXT NOT NULL,
            actual_line_amount TEXT NOT NULL,
            UNIQUE (posted_invoice_id, po_line_id)
        );

        PRAGMA user_version = 1;
        """
    )

    vendors = [
        (
            "V-ACME",
            "Acme Industrial Supplies LLC",
            normalize_match_key("Acme Industrial Supplies LLC"),
            json.dumps(["Acme Industrial", "Acme Supplies"], separators=(",", ":")),
            1,
        ),
        (
            "V-DELTA",
            "Delta Components Ltd",
            normalize_match_key("Delta Components Ltd"),
            json.dumps(["Delta Components"], separators=(",", ":")),
            1,
        ),
    ]
    connection.executemany("INSERT INTO vendors VALUES (?, ?, ?, ?, ?)", vendors)

    purchase_orders = [
        ("PO-0999", normalize_match_key("PO-0999"), "V-ACME", "USD", "CLOSED"),
        ("PO-1001", normalize_match_key("PO-1001"), "V-ACME", "USD", "OPEN"),
        ("PO-1002", normalize_match_key("PO-1002"), "V-ACME", "USD", "OPEN"),
        ("PO-1003", normalize_match_key("PO-1003"), "V-ACME", "USD", "OPEN"),
        ("PO-2001", normalize_match_key("PO-2001"), "V-DELTA", "USD", "OPEN"),
    ]
    connection.executemany("INSERT INTO purchase_orders VALUES (?, ?, ?, ?, ?)", purchase_orders)

    po_lines = [
        (
            "PO-0999-L1",
            "PO-0999",
            1,
            "FIL-900",
            normalize_match_key("FIL-900"),
            "Replacement Filter",
            normalize_match_key("Replacement Filter"),
            "EA",
            "1",
            "1",
            "100.00",
        ),
        (
            "PO-1001-L1",
            "PO-1001",
            1,
            "WID-100",
            normalize_match_key("WID-100"),
            "Industrial Widget",
            normalize_match_key("Industrial Widget"),
            "EA",
            "10",
            "10",
            "100.00",
        ),
        (
            "PO-1001-L2",
            "PO-1001",
            2,
            "BOL-200",
            normalize_match_key("BOL-200"),
            "Mounting Bolt Pack",
            normalize_match_key("Mounting Bolt Pack"),
            "EA",
            "5",
            "5",
            "20.00",
        ),
        (
            "PO-1002-L1",
            "PO-1002",
            1,
            "SEN-300",
            normalize_match_key("SEN-300"),
            "Safety Sensor",
            normalize_match_key("Safety Sensor"),
            "EA",
            "2",
            "2",
            "250.00",
        ),
        (
            "PO-1003-L1",
            "PO-1003",
            1,
            "CAB-400",
            normalize_match_key("CAB-400"),
            "Cable Harness",
            normalize_match_key("Cable Harness"),
            "EA",
            "4",
            "4",
            "125.00",
        ),
        (
            "PO-2001-L1",
            "PO-2001",
            1,
            "VAL-500",
            normalize_match_key("VAL-500"),
            "Control Valve",
            normalize_match_key("Control Valve"),
            "EA",
            "10",
            "6",
            "50.00",
        ),
    ]
    connection.executemany(
        "INSERT INTO po_lines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", po_lines
    )

    posted_invoices = [
        (
            "LEDGER-SEED-001",
            None,
            "SEED",
            "V-ACME",
            "ACME-2026-000",
            normalize_match_key("ACME-2026-000"),
            "2026-06-01",
            "USD",
            "100.00",
            "10.00",
            "110.00",
            "PO-0999",
            "2026-06-01T10:00:00Z",
        ),
        (
            "LEDGER-SEED-002",
            None,
            "SEED",
            "V-DELTA",
            "DELTA-2026-009",
            normalize_match_key("DELTA-2026-009"),
            "2026-06-15",
            "USD",
            "200.00",
            "20.00",
            "220.00",
            "PO-2001",
            "2026-06-15T10:00:00Z",
        ),
    ]
    connection.executemany(
        "INSERT INTO posted_invoices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        posted_invoices,
    )
    connection.executemany(
        "INSERT INTO allocations VALUES (?, ?, ?, ?, ?, ?)",
        [
            (
                "ALLOC-SEED-001",
                "LEDGER-SEED-001",
                "PO-0999-L1",
                "1",
                "100.00",
                "100.00",
            ),
            (
                "ALLOC-SEED-002",
                "LEDGER-SEED-002",
                "PO-2001-L1",
                "4",
                "200.00",
                "200.00",
            ),
        ],
    )
    connection.commit()
    connection.execute("VACUUM")
    connection.close()


def input_manifest(invoice: dict) -> dict:
    return {
        "vendor": invoice["vendor"],
        "invoice_number": invoice["invoice_number"],
        "invoice_date": invoice["invoice_date"],
        "po_number": invoice["po_number"],
        "currency": invoice["currency"],
        "lines": invoice["lines"],
        "subtotal": invoice["subtotal"],
        "tax": invoice["tax"],
        "total": invoice["total"],
    }


def build_manifest() -> dict:
    cases = {
        "happy": {
            "expected": {
                "run_state": "POSTED",
                "decision": "AUTO_CLEARED",
                "execution": "POSTED",
                "reason_code": None,
                "candidate_po": None,
                "ledger_delta": 1,
                "allocation_delta": [
                    {
                        "po_number": "PO-1001",
                        "sku": "WID-100",
                        "quantity": "8",
                        "remaining_ordered_quantity": "2",
                        "remaining_received_quantity": "2",
                    },
                    {
                        "po_number": "PO-1001",
                        "sku": "BOL-200",
                        "quantity": "5",
                        "remaining_ordered_quantity": "0",
                        "remaining_received_quantity": "0",
                    },
                ],
            }
        },
        "duplicate": {
            "expected": {
                "run_state": "NEEDS_REVIEW",
                "decision": "NEEDS_REVIEW",
                "execution": "BLOCKED",
                "reason_code": "DUPLICATE",
                "candidate_po": None,
                "ledger_delta": 0,
                "allocation_delta": [],
            }
        },
        "missing_po": {
            "expected": {
                "run_state": "AWAITING_PO_CONFIRMATION",
                "decision": "NEEDS_REVIEW",
                "execution": "AWAITING_CONFIRMATION",
                "reason_code": "MISSING_PO",
                "candidate_po": "PO-1002",
                "ledger_delta": 0,
                "allocation_delta": [],
            },
            "after_confirmation": {
                "run_state": "POSTED",
                "confirmed_po": "PO-1002",
                "same_run_id": True,
                "repeated_confirmation_same_ledger_id": True,
                "decision": "AUTO_CLEARED",
                "execution": "POSTED",
                "reason_code": None,
                "ledger_delta": 1,
                "unit_price_variance_percent": "0.4",
                "aggregate_price_variance": "2.00",
                "allocation_delta": [
                    {
                        "po_number": "PO-1002",
                        "sku": "SEN-300",
                        "quantity": "2",
                        "remaining_ordered_quantity": "0",
                        "remaining_received_quantity": "0",
                    }
                ],
            },
        },
        "receipt_capacity": {
            "expected": {
                "run_state": "NEEDS_REVIEW",
                "decision": "NEEDS_REVIEW",
                "execution": "BLOCKED",
                "reason_code": "RECEIPT_CAPACITY_EXCEEDED",
                "candidate_po": None,
                "ledger_delta": 0,
                "allocation_delta": [],
                "requested_quantity": "3",
                "remaining_received_quantity": "2",
                "ordered_capacity_passes": True,
                "po_basis_capacity_passes": True,
            }
        },
    }
    for fixture_id, invoice in FIXTURES.items():
        fixture_path = FIXTURE_DIR / f"{fixture_id}.pdf"
        cases[fixture_id]["file"] = f"data/fixtures/{fixture_id}.pdf"
        cases[fixture_id]["pdf_sha256"] = pdf_sha256(fixture_path)
        cases[fixture_id]["input"] = input_manifest(invoice)
    return {"schema_version": 1, "currency": "USD", "fixtures": cases}


def validate(manifest: dict) -> None:
    assert set(manifest["fixtures"]) == set(FIXTURES)
    for fixture_id, case in manifest["fixtures"].items():
        fixture_path = FIXTURE_DIR / f"{fixture_id}.pdf"
        assert fixture_path.read_bytes().startswith(b"%PDF-")
        assert 1_000 < fixture_path.stat().st_size <= 10 * 1024 * 1024
        reader = PdfReader(fixture_path)
        assert not reader.is_encrypted and 1 <= len(reader.pages) <= 10
        assert case["input"]["invoice_number"] in (
            reader.pages[0].extract_text() or ""
        )
        assert case["pdf_sha256"] == pdf_sha256(fixture_path)

    connection = sqlite3.connect(SEED_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    expected_counts = {
        "vendors": 2,
        "purchase_orders": 5,
        "po_lines": 6,
        "runs": 0,
        "posted_invoices": 2,
        "allocations": 2,
    }
    for table, expected_count in expected_counts.items():
        actual_count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        assert actual_count == expected_count, (table, actual_count)

    duplicate = connection.execute(
        """
        SELECT COUNT(*)
        FROM posted_invoices pi
        JOIN vendors v ON v.id = pi.vendor_id
        WHERE v.normalized_name = ? AND pi.normalized_invoice_number = ?
        """,
        (
            normalize_match_key("Acme Industrial Supplies LLC"),
            normalize_match_key("ACME-2026-000"),
        ),
    ).fetchone()[0]
    assert duplicate == 1

    delta_line = connection.execute(
        """
        SELECT pl.ordered_quantity, pl.received_quantity,
               COALESCE(SUM(a.invoice_quantity), '0') AS allocated_quantity
        FROM po_lines pl
        LEFT JOIN allocations a ON a.po_line_id = pl.id
        WHERE pl.id = 'PO-2001-L1'
        GROUP BY pl.id
        """
    ).fetchone()
    assert Decimal(delta_line["ordered_quantity"]) == Decimal("10")
    assert Decimal(delta_line["received_quantity"]) == Decimal("6")
    assert Decimal(delta_line["allocated_quantity"]) == Decimal("4")
    assert Decimal(delta_line["received_quantity"]) - Decimal(
        delta_line["allocated_quantity"]
    ) == Decimal("2")

    sensor_candidates = connection.execute(
        """
        SELECT po.po_number
        FROM purchase_orders po
        JOIN po_lines pl ON pl.po_number = po.po_number
        WHERE po.vendor_id = 'V-ACME'
          AND po.status = 'OPEN'
          AND po.currency = 'USD'
          AND pl.sku = 'SEN-300'
        """
    ).fetchall()
    assert [row["po_number"] for row in sensor_candidates] == ["PO-1002"]
    assert (
        connection.execute(
            "SELECT COUNT(*) FROM purchase_orders WHERE vendor_id = 'V-ACME' AND status = 'OPEN'"
        ).fetchone()[0]
        == 3
    )
    duplicate_allocation = connection.execute(
        """
        SELECT a.invoice_quantity, a.po_basis_amount, a.actual_line_amount
        FROM allocations a
        WHERE a.posted_invoice_id = 'LEDGER-SEED-001'
          AND a.po_line_id = 'PO-0999-L1'
        """
    ).fetchone()
    assert tuple(duplicate_allocation) == ("1", "100.00", "100.00")
    connection.close()

    fixtures = manifest["fixtures"]
    assert fixtures["happy"]["expected"]["run_state"] == "POSTED"
    assert fixtures["happy"]["expected"]["ledger_delta"] == 1
    assert (
        fixtures["missing_po"]["expected"]["run_state"]
        == "AWAITING_PO_CONFIRMATION"
    )
    assert fixtures["missing_po"]["expected"]["candidate_po"] == "PO-1002"
    assert fixtures["missing_po"]["after_confirmation"]["same_run_id"] is True
    assert (
        fixtures["missing_po"]["after_confirmation"][
            "repeated_confirmation_same_ledger_id"
        ]
        is True
    )
    assert (
        fixtures["receipt_capacity"]["expected"]["remaining_received_quantity"]
        == "2"
    )
    assert fixtures["receipt_capacity"]["expected"]["ordered_capacity_passes"] is True
    assert fixtures["receipt_capacity"]["expected"]["po_basis_capacity_passes"] is True


def main() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for fixture_id, invoice in FIXTURES.items():
        build_pdf(FIXTURE_DIR / f"{fixture_id}.pdf", invoice)
    build_database(SEED_PATH)
    manifest = build_manifest()
    CASES_PATH.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    validate(manifest)
    print("Built and validated 4 invoice PDFs, data/seed.sqlite, and data/cases.json")


if __name__ == "__main__":
    main()
