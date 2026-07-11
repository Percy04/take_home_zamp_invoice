"""Submit the local happy fixture to Azure and record a validated response."""

from __future__ import annotations

import io
import json
import os
from decimal import Decimal
from pathlib import Path

from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.ai.documentintelligence.models import DocumentAnalysisFeature
from azure.core.credentials import AzureKeyCredential
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
CASES_PATH = ROOT / "data" / "cases.json"
FIXTURE_IDS = (
    "happy",
    "happy_layout_c_scanned",
    "bundle_known",
    "bundle_unknown",
    "tax_inclusive",
)


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


def source_ref(source_id: str, label: str, value: dict, **coordinates) -> dict:
    regions = value.get("boundingRegions") or []
    return {
        "id": source_id,
        "content": value.get("content", ""),
        "confidence": value.get("confidence"),
        "page": coordinates.get("page")
        or (regions[0].get("pageNumber") if regions else None),
        "table_index": coordinates.get("table_index"),
        "row": coordinates.get("row"),
        "column": coordinates.get("column"),
        "line_index": coordinates.get("line_index"),
        "label": label,
    }


def build_source_catalogue(result) -> list[dict]:
    """Flatten Azure evidence into the stable SourceRef contract."""
    payload = result.as_dict()
    catalogue: list[dict] = []
    fields = (payload.get("documents") or [{}])[0].get("fields") or {}

    def add_field(field_id: str, label: str, value: dict) -> None:
        catalogue.append(source_ref(field_id, label, value))
        for child_label, child in (value.get("valueObject") or {}).items():
            prefix = "tax" if "tax" in field_id.lower() else field_id
            add_field(f"{prefix}.{child_label}", child_label, child)

    for label, value in fields.items():
        if label == "Items":
            for item_index, item in enumerate(value.get("valueArray") or []):
                for child_label, child in (item.get("valueObject") or {}).items():
                    add_field(f"item.{item_index}.{child_label}", child_label, child)
        elif "tax" in label.lower() and value.get("valueArray"):
            for tax_index, tax in enumerate(value["valueArray"]):
                for child_label, child in (tax.get("valueObject") or {}).items():
                    add_field(f"tax.{tax_index}.{child_label}", child_label, child)
        else:
            add_field(f"field.{label}", label, value)

    for table_index, table in enumerate(payload.get("tables") or []):
        for cell in table.get("cells") or []:
            catalogue.append(
                source_ref(
                    f"table.{table_index}.r{cell['rowIndex']}.c{cell['columnIndex']}",
                    "table cell",
                    cell,
                    table_index=table_index,
                    row=cell["rowIndex"],
                    column=cell["columnIndex"],
                )
            )

    for page in payload.get("pages") or []:
        words = page.get("words") or []
        for line_index, line in enumerate(page.get("lines") or []):
            confidences = [
                word["confidence"]
                for word in words
                if word.get("confidence") is not None
                and any(
                    ws["offset"] < ls["offset"] + ls["length"]
                    and ls["offset"] < ws["offset"] + ws["length"]
                    for ws in word.get("spans")
                    or ([word["span"]] if word.get("span") else [])
                    for ls in line.get("spans") or []
                )
            ]
            catalogue.append(
                source_ref(
                    f"line.{page['pageNumber']}.l{line_index}",
                    "OCR line",
                    {**line, "confidence": min(confidences) if confidences else None},
                    page=page["pageNumber"],
                    line_index=line_index,
                )
            )

    for pair_index, pair in enumerate(payload.get("keyValuePairs") or []):
        for side in ("key", "value"):
            if pair.get(side):
                catalogue.append(
                    source_ref(
                        f"key_value.{pair_index}.{side}",
                        f"key-value {side}",
                        pair[side],
                    )
                )
    return catalogue


def validate_result(result, expected: dict, fixture_id: str) -> list[dict]:
    assert result.model_id == "prebuilt-invoice"
    assert result.documents, "Azure returned no invoice document"
    document = result.documents[0]
    fields = document.fields or {}
    required = [
        "VendorName",
        "InvoiceId",
        "InvoiceDate",
        "PurchaseOrder",
        "InvoiceTotal",
    ]
    if expected["subtotal"] is not None:
        required += ["SubTotal", "TotalTax"]
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
    assert (
        get_azure_value(fields["PurchaseOrder"], "value_string", "valueString")
        == expected["po_number"]
    )
    if expected["subtotal"] is not None:
        assert currency_amount(fields["SubTotal"]) == Decimal(expected["subtotal"])
        assert currency_amount(fields["TotalTax"]) == Decimal(expected["tax"])
    assert currency_amount(fields["InvoiceTotal"]) == Decimal(expected["total"])
    total_currency = get_azure_value(
        fields["InvoiceTotal"], "value_currency", "valueCurrency"
    )
    assert (
        get_azure_value(total_currency, "currency_code", "currencyCode")
        == expected["currency"]
    )

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
        required_item_fields = {"Description", "Quantity", "UnitPrice", "Amount"}
        if fixture_id != "happy_layout_c_scanned":
            required_item_fields.add("Unit")
        if expected_line["sku"]:
            required_item_fields.add("ProductCode")
        assert required_item_fields <= item_values.keys(), (
            f"Invoice item fields are missing: {sorted(item_values)}"
        )
        if expected_line["sku"]:
            assert (
                get_azure_value(
                    item_values["ProductCode"], "value_string", "valueString"
                )
                == expected_line["sku"]
            )
        assert (
            get_azure_value(item_values["Description"], "value_string", "valueString")
            == expected_line["description"]
        )
        assert Decimal(
            str(get_azure_value(item_values["Quantity"], "value_number", "valueNumber"))
        ) == Decimal(expected_line["quantity"])
        if "Unit" in item_values:
            unit = get_azure_value(item_values["Unit"], "value_string", "valueString")
            assert unit.upper() in {expected_line["uom"], "PCS"}
        assert currency_amount(item_values["UnitPrice"]) == Decimal(
            expected_line["unit_price"]
        )
        assert currency_amount(item_values["Amount"]) == Decimal(
            expected_line["amount"]
        )
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
    if fixture_id == "happy_layout_c_scanned":
        words = [word for page in (result.pages or []) for word in (page.words or [])]
        lines = [line for page in (result.pages or []) for line in (page.lines or [])]
        assert words and lines and all(word.confidence is not None for word in words)
    # Optional evidence requested from the same analysis call is preserved when returned.
    if result.key_value_pairs:
        assert all(
            pair.key and has_source_location(pair.key)
            for pair in result.key_value_pairs
        )
    catalogue = build_source_catalogue(result)
    assert len({ref["id"] for ref in catalogue}) == len(catalogue)
    if fixture_id == "happy_layout_c_scanned":
        assert all(
            ref["confidence"] is not None
            for ref in catalogue
            if ref["id"].startswith("line.")
        )
    if fixture_id == "tax_inclusive":
        assert any("18%" in ref["content"] for ref in catalogue)
    return catalogue


def main() -> None:
    load_dotenv(ROOT / ".env")
    endpoint = os.getenv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
    key = os.getenv("AZURE_DOCUMENT_INTELLIGENCE_KEY")
    if not endpoint or not key:
        raise SystemExit("Set Azure Document Intelligence credentials in .env")
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))["fixtures"]
    client = DocumentIntelligenceClient(endpoint, AzureKeyCredential(key))
    for fixture_id in FIXTURE_IDS:
        pdf_path = ROOT / "data" / "fixtures" / f"{fixture_id}.pdf"
        if not pdf_path.exists():
            raise SystemExit("Run scripts/build_demo_data.py first")
        with pdf_path.open("rb") as pdf:
            result = client.begin_analyze_document(
                "prebuilt-invoice",
                io.BytesIO(pdf.read()),
                features=[DocumentAnalysisFeature.KEY_VALUE_PAIRS],
            ).result(timeout=60)
        catalogue = validate_result(result, cases[fixture_id]["input"], fixture_id)
        recording_path = ROOT / "tests" / "recordings" / f"{fixture_id}_azure.json"
        recording_path.parent.mkdir(parents=True, exist_ok=True)
        recording_path.write_text(
            json.dumps(result.as_dict(), indent=2, default=str) + "\n", encoding="utf-8"
        )
        source_path = ROOT / "tests" / "recordings" / f"{fixture_id}_sources.json"
        source_path.write_text(json.dumps(catalogue, indent=2) + "\n", encoding="utf-8")
        print(
            f"Azure verification passed for {fixture_id}; recorded {recording_path.relative_to(ROOT)}"
        )


if __name__ == "__main__":
    main()
