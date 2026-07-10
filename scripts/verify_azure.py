"""Submit the local happy fixture to Azure and record a validated response."""

from __future__ import annotations

import io
import json
import os
from decimal import Decimal
from pathlib import Path

from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.core.credentials import AzureKeyCredential
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
PDF_PATH = ROOT / "data" / "fixtures" / "happy.pdf"
CASES_PATH = ROOT / "data" / "cases.json"
RECORDING_PATH = ROOT / "tests" / "recordings" / "happy_azure.json"


def get_azure_value(obj, snake_name: str, camel_name: str | None = None, default=None):
    found = getattr(obj, snake_name, None)
    if found is not None:
        return found
    if hasattr(obj, "get"):
        return obj.get(camel_name or snake_name, default)
    return default


def has_source_location(obj) -> bool:
    return bool(
        get_azure_value(obj, "bounding_regions", "boundingRegions")
        or get_azure_value(obj, "spans")
    )


def currency_amount(field) -> Decimal:
    currency = get_azure_value(field, "value_currency", "valueCurrency")
    return Decimal(str(get_azure_value(currency, "amount")))


def main() -> None:
    load_dotenv(ROOT / ".env")
    endpoint = os.getenv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
    key = os.getenv("AZURE_DOCUMENT_INTELLIGENCE_KEY")
    if not endpoint or not key:
        raise SystemExit("Set Azure Document Intelligence credentials in .env")
    if not PDF_PATH.exists():
        raise SystemExit("Run scripts/build_demo_data.py first")

    client = DocumentIntelligenceClient(endpoint, AzureKeyCredential(key))
    with PDF_PATH.open("rb") as pdf:
        result = client.begin_analyze_document(
            "prebuilt-invoice",
            io.BytesIO(pdf.read()),
        ).result(timeout=60)

    assert result.model_id == "prebuilt-invoice"
    assert result.documents, "Azure returned no invoice document"
    document = result.documents[0]
    fields = document.fields or {}
    expected = json.loads(CASES_PATH.read_text(encoding="utf-8"))["fixtures"][
        "happy"
    ]["input"]
    required = [
        "VendorName",
        "InvoiceId",
        "InvoiceDate",
        "PurchaseOrder",
        "SubTotal",
        "TotalTax",
        "InvoiceTotal",
    ]
    missing = [name for name in required if not fields.get(name)]
    assert not missing, f"Missing usable fields: {', '.join(missing)}"
    assert (
        get_azure_value(fields["VendorName"], "value_string", "valueString")
        == expected["vendor"]
    )
    assert (
        get_azure_value(fields["InvoiceId"], "value_string", "valueString")
        == expected["invoice_number"]
    )
    assert (
        str(get_azure_value(fields["InvoiceDate"], "value_date", "valueDate"))
        == expected["invoice_date"]
    )
    assert get_azure_value(
        fields["PurchaseOrder"], "value_string", "valueString"
    ) == expected["po_number"]
    assert currency_amount(fields["SubTotal"]) == Decimal(expected["subtotal"])
    assert currency_amount(fields["TotalTax"]) == Decimal(expected["tax"])
    assert currency_amount(fields["InvoiceTotal"]) == Decimal(expected["total"])
    total_currency = get_azure_value(
        fields["InvoiceTotal"], "value_currency", "valueCurrency"
    )
    assert get_azure_value(total_currency, "currency_code", "currencyCode") == expected[
        "currency"
    ]

    items_field = fields.get("Items")
    items = get_azure_value(items_field, "value_array", "valueArray", []) or []
    assert len(items) == len(expected["lines"]), "Unexpected invoice item count"
    assert all(
        get_azure_value(fields[name], "confidence") is not None for name in required
    )
    assert all(has_source_location(fields[name]) for name in required), (
        "Critical fields are missing source locations"
    )
    for item, expected_line in zip(items, expected["lines"], strict=True):
        item_values = get_azure_value(item, "value_object", "valueObject", {}) or {}
        required_item_fields = {
            "ProductCode",
            "Description",
            "Quantity",
            "Unit",
            "UnitPrice",
            "Amount",
        }
        assert required_item_fields <= item_values.keys(), "Invoice item fields are missing"
        assert get_azure_value(
            item_values["ProductCode"], "value_string", "valueString"
        ) == expected_line["sku"]
        assert get_azure_value(
            item_values["Description"], "value_string", "valueString"
        ) == expected_line["description"]
        assert Decimal(
            str(get_azure_value(item_values["Quantity"], "value_number", "valueNumber"))
        ) == Decimal(expected_line["quantity"])
        assert get_azure_value(
            item_values["Unit"], "value_string", "valueString"
        ) == expected_line["uom"]
        assert currency_amount(item_values["UnitPrice"]) == Decimal(
            expected_line["unit_price"]
        )
        assert currency_amount(item_values["Amount"]) == Decimal(expected_line["amount"])
    item_fields = [
        field
        for item in items
        for field in (
            get_azure_value(item, "value_object", "valueObject", {}) or {}
        ).values()
    ]
    assert item_fields and all(
        get_azure_value(field, "confidence") is not None for field in item_fields
    ), "Invoice items are missing confidence"
    assert all(has_source_location(field) for field in item_fields), (
        "Invoice items are missing source locations"
    )
    table_cells = [cell for table in (result.tables or []) for cell in table.cells]
    assert table_cells, "No usable tables"
    assert all(has_source_location(cell) for cell in table_cells), (
        "Table cells are missing source locations"
    )

    RECORDING_PATH.parent.mkdir(parents=True, exist_ok=True)
    RECORDING_PATH.write_text(
        json.dumps(result.as_dict(), indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(
        f"Azure verification passed: {len(fields)} fields, {len(items)} items, "
        f"{len(result.tables)} tables; recorded {RECORDING_PATH.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
