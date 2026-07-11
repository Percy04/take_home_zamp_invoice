import tempfile
import unittest
import hashlib
import json
from io import BytesIO
from types import SimpleNamespace
from pathlib import Path

from pipeline import (
    InvoiceLineMapping,
    InvoiceMapping,
    MappingError,
    PDFValidationError,
    build_source_catalogue,
    extract_invoice,
    map_invoice,
    validate_and_store_pdf,
)
from pypdf import PdfWriter


ROOT = Path(__file__).resolve().parents[1]


class PDFIntakeTests(unittest.TestCase):
    def test_valid_pdf_is_stored_by_run_id(self):
        content = (ROOT / "data" / "fixtures" / "happy.pdf").read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            stored = validate_and_store_pdf(content, "RUN-123", Path(directory))

            self.assertEqual(stored.path, Path(directory) / "uploads" / "RUN-123.pdf")
            self.assertEqual(stored.path.read_bytes(), content)
            self.assertEqual(stored.sha256, hashlib.sha256(content).hexdigest())

    def test_rejects_invalid_pdf_before_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime_dir = Path(directory)
            for content in (b"", b"not a pdf", b"%PDF-broken"):
                with self.subTest(content=content):
                    with self.assertRaises(PDFValidationError) as raised:
                        validate_and_store_pdf(content, "RUN-123", runtime_dir)
                    self.assertEqual(
                        raised.exception.reason_code, "DOCUMENT_UNREADABLE"
                    )
            self.assertFalse((runtime_dir / "uploads").exists())

    def test_rejects_size_encryption_and_page_count_boundaries(self):
        def pdf_with_pages(page_count, encrypted=False):
            output = BytesIO()
            writer = PdfWriter()
            for _ in range(page_count):
                writer.add_blank_page(width=72, height=72)
            if encrypted:
                writer.encrypt("secret")
            writer.write(output)
            return output.getvalue()

        invalid_documents = (
            b"%PDF-" + b"0" * (10 * 1024 * 1024),
            pdf_with_pages(1, encrypted=True),
            pdf_with_pages(0),
            pdf_with_pages(11),
        )
        with tempfile.TemporaryDirectory() as directory:
            for content in invalid_documents:
                with self.subTest(size=len(content)):
                    with self.assertRaises(PDFValidationError):
                        validate_and_store_pdf(content, "RUN-123", Path(directory))

    def test_accepts_image_only_scanned_pdf(self):
        content = (
            ROOT / "data" / "fixtures" / "happy_layout_c_scanned.pdf"
        ).read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            stored = validate_and_store_pdf(content, "RUN-SCAN", Path(directory))

            self.assertTrue(stored.path.exists())


class ExtractionAndMappingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.recording_path = ROOT / "tests" / "recordings" / "happy_azure.json"
        cls.recording = json.loads(cls.recording_path.read_text(encoding="utf-8"))

    def test_recorded_extraction_builds_stable_source_catalogue(self):
        payload = extract_invoice(b"unused offline", recording_path=self.recording_path)
        sources = build_source_catalogue(payload)
        by_id = {source.id: source for source in sources}

        self.assertEqual(payload["modelId"], "prebuilt-invoice")
        self.assertEqual(by_id["field.InvoiceId"].content, "ACME-2026-001")
        self.assertEqual(by_id["item.0.ProductCode"].content, "WID-100")
        self.assertIn("table.0.r0.c0", by_id)
        self.assertTrue(any(source.id.startswith("line.1.l") for source in sources))

    def test_mapping_uses_one_structured_call_and_rejects_unknown_sources(self):
        sources = build_source_catalogue(self.recording)
        known_id = sources[0].id
        parsed = InvoiceMapping(
            vendor_source_id=known_id,
            lines=[InvoiceLineMapping(description_source_id=known_id)],
        )

        class FakeResponses:
            def __init__(self):
                self.calls = []

            def parse(self, **kwargs):
                self.calls.append(kwargs)
                return SimpleNamespace(output_parsed=parsed)

        responses = FakeResponses()
        result = map_invoice(sources, SimpleNamespace(responses=responses))
        self.assertEqual(result, parsed)
        self.assertEqual(len(responses.calls), 1)
        self.assertIs(responses.calls[0]["text_format"], InvoiceMapping)
        self.assertEqual(responses.calls[0]["max_output_tokens"], 4000)

        parsed.vendor_source_id = "field.DoesNotExist"
        with self.assertRaises(MappingError):
            map_invoice(sources, SimpleNamespace(responses=responses))


if __name__ == "__main__":
    unittest.main()
