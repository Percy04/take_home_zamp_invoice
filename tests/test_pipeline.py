import tempfile
import unittest
import hashlib
from io import BytesIO
from pathlib import Path

from pipeline import PDFValidationError, validate_and_store_pdf
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


if __name__ == "__main__":
    unittest.main()
