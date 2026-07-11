"""Invoice intake and processing pipeline."""

from io import BytesIO
from pathlib import Path
from dataclasses import dataclass
import hashlib

from pypdf import PdfReader

from storage import DEFAULT_RUNTIME_PATH


MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 10


class PDFValidationError(ValueError):
    """The uploaded bytes are not an accepted invoice PDF."""

    decision = "NEEDS_REVIEW"
    execution = "BLOCKED"
    reason_code = "DOCUMENT_UNREADABLE"


@dataclass(frozen=True)
class StoredPDF:
    path: Path
    sha256: str


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
