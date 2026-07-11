"""Invoice intake and processing pipeline."""

from io import BytesIO
from pathlib import Path
from dataclasses import dataclass
import hashlib
import json
import os
from typing import Any

from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.ai.documentintelligence.models import DocumentAnalysisFeature
from azure.core.credentials import AzureKeyCredential
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field
from pypdf import PdfReader

from storage import DEFAULT_RUNTIME_PATH


MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 10
ROOT = Path(__file__).resolve().parent


class PDFValidationError(ValueError):
    """The uploaded bytes are not an accepted invoice PDF."""

    decision = "NEEDS_REVIEW"
    execution = "BLOCKED"
    reason_code = "DOCUMENT_UNREADABLE"


class ExtractionError(RuntimeError):
    reason_code = "EXTRACTION_FAILED"


class MappingError(RuntimeError):
    reason_code = "MAPPING_FAILED"


@dataclass(frozen=True)
class StoredPDF:
    path: Path
    sha256: str


class SourceRef(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    content: str
    confidence: float | None = None
    page: int | None = None
    table_index: int | None = None
    row: int | None = None
    column: int | None = None
    line_index: int | None = None
    label: str


class InvoiceLineMapping(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sku_source_id: str | None = None
    description_source_id: str | None = None
    quantity_source_id: str | None = None
    uom_source_id: str | None = None
    unit_price_source_id: str | None = None
    amount_source_id: str | None = None
    tax_inclusion_source_id: str | None = None
    tax_rate_source_id: str | None = None
    tax_amount_source_id: str | None = None


class InvoiceMapping(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vendor_source_id: str | None = None
    invoice_number_source_id: str | None = None
    invoice_date_source_id: str | None = None
    po_number_source_id: str | None = None
    currency_source_id: str | None = None
    subtotal_source_id: str | None = None
    tax_source_id: str | None = None
    tax_inclusion_source_id: str | None = None
    tax_rate_source_id: str | None = None
    total_source_id: str | None = None
    lines: list[InvoiceLineMapping] = Field(default_factory=list)
    excluded_source_ids: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


def validate_and_store_pdf(
    content: bytes, run_id: str, runtime_dir: Path = DEFAULT_RUNTIME_PATH.parent
) -> StoredPDF:
    """Validate PDF bytes fully, then store them under the trusted run ID."""
    if not content:
        raise PDFValidationError("The PDF is empty.")
    if len(content) > MAX_PDF_BYTES:
        raise PDFValidationError("The PDF exceeds the 10 MiB limit.")
    if not content.startswith(b"%PDF-"):
        raise PDFValidationError("The file is not a PDF.")
    if not run_id or any(
        character
        not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
        for character in run_id
    ):
        raise PDFValidationError("The run ID is invalid.")

    try:
        reader = PdfReader(BytesIO(content))
        if reader.is_encrypted:
            raise PDFValidationError("Encrypted PDFs are not supported.")
        page_count = len(reader.pages)
    except PDFValidationError:
        raise
    except Exception as error:
        raise PDFValidationError("The PDF is malformed.") from error

    if not 1 <= page_count <= MAX_PDF_PAGES:
        raise PDFValidationError("The PDF must contain between 1 and 10 pages.")

    upload_dir = runtime_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    destination = upload_dir / f"{run_id}.pdf"
    destination.write_bytes(content)
    return StoredPDF(destination, hashlib.sha256(content).hexdigest())


def extract_invoice(
    pdf_bytes: bytes,
    client: DocumentIntelligenceClient | None = None,
    recording_path: Path | None = None,
) -> dict:
    """Extract invoice evidence live, or load an explicitly selected test recording."""
    if recording_path is not None:
        return json.loads(recording_path.read_text(encoding="utf-8"))
    try:
        if client is None:
            load_dotenv(ROOT / ".env")
            endpoint = os.getenv("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
            key = os.getenv("AZURE_DOCUMENT_INTELLIGENCE_KEY")
            if not endpoint or not key:
                raise ExtractionError("Azure Document Intelligence is not configured.")
            client = DocumentIntelligenceClient(endpoint, AzureKeyCredential(key))
        result = client.begin_analyze_document(
            "prebuilt-invoice",
            BytesIO(pdf_bytes),
            features=[DocumentAnalysisFeature.KEY_VALUE_PAIRS],
        ).result(timeout=60)
        payload = result.as_dict()
        if payload.get("modelId") != "prebuilt-invoice" or not payload.get("documents"):
            raise ExtractionError("Azure returned no usable invoice document.")
        return payload
    except ExtractionError:
        raise
    except Exception as error:
        raise ExtractionError("Invoice extraction failed.") from error


def _source_ref(source_id: str, label: str, value: dict, **coordinates) -> SourceRef:
    regions = value.get("boundingRegions") or []
    return SourceRef(
        id=source_id,
        content=value.get("content", ""),
        confidence=value.get("confidence"),
        page=coordinates.get("page")
        or (regions[0].get("pageNumber") if regions else None),
        table_index=coordinates.get("table_index"),
        row=coordinates.get("row"),
        column=coordinates.get("column"),
        line_index=coordinates.get("line_index"),
        label=label,
    )


def build_source_catalogue(payload: dict) -> list[SourceRef]:
    """Flatten Azure evidence, converting unusable payloads to a safe failure."""
    try:
        catalogue = _build_source_catalogue(payload)
    except ExtractionError:
        raise
    except Exception as error:
        raise ExtractionError("Azure returned unusable invoice evidence.") from error
    if not catalogue:
        raise ExtractionError("Azure returned no usable invoice evidence.")
    return catalogue


def _build_source_catalogue(payload: dict) -> list[SourceRef]:
    catalogue: list[SourceRef] = []
    fields = (payload.get("documents") or [{}])[0].get("fields") or {}

    def add_field(source_id: str, label: str, value: dict) -> None:
        catalogue.append(_source_ref(source_id, label, value))

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
                _source_ref(
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
                and _spans_overlap(word.get("span"), line.get("spans") or [])
            ]
            catalogue.append(
                _source_ref(
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
                    _source_ref(
                        f"key_value.{pair_index}.{side}",
                        f"key-value {side}",
                        pair[side],
                    )
                )
    if len({source.id for source in catalogue}) != len(catalogue):
        raise ExtractionError("Azure returned ambiguous evidence identifiers.")
    return catalogue


def _spans_overlap(word_span: dict | None, line_spans: list[dict]) -> bool:
    if not word_span:
        return False
    return any(
        word_span["offset"] < line_span["offset"] + line_span["length"]
        and line_span["offset"] < word_span["offset"] + word_span["length"]
        for line_span in line_spans
    )


def map_invoice(sources: list[SourceRef], client: Any | None = None) -> InvoiceMapping:
    """Ask OpenAI once to select evidence IDs, then reject unknown references."""
    try:
        if client is None:
            load_dotenv(ROOT / ".env")
            from openai import OpenAI

            client = OpenAI(timeout=30, max_retries=1)
        evidence = json.dumps([source.model_dump() for source in sources])
        response = client.responses.parse(
            model=os.getenv("OPENAI_MODEL", "gpt-5.4-mini"),
            input=[
                {
                    "role": "system",
                    "content": "Map invoice fields only by selecting provided source IDs. Never infer or rewrite values.",
                },
                {"role": "user", "content": evidence},
            ],
            text_format=InvoiceMapping,
            max_output_tokens=4000,
        )
        mapping = response.output_parsed
        if mapping is None:
            raise MappingError("OpenAI returned no usable invoice mapping.")
        known_ids = {source.id for source in sources}
        referenced_ids = _mapping_source_ids(mapping)
        if not referenced_ids <= known_ids:
            raise MappingError("OpenAI referenced unknown invoice evidence.")
        return mapping
    except MappingError:
        raise
    except Exception as error:
        raise MappingError("Invoice mapping failed.") from error


def _mapping_source_ids(mapping: InvoiceMapping) -> set[str]:
    values = mapping.model_dump()
    source_ids = {
        value
        for name, value in values.items()
        if name.endswith("_source_id") and value is not None
    }
    source_ids.update(mapping.excluded_source_ids)
    for line in mapping.lines:
        source_ids.update(
            value
            for name, value in line.model_dump().items()
            if name.endswith("_source_id") and value is not None
        )
    return source_ids
