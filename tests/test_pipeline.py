import tempfile
import unittest
import hashlib
from pathlib import Path

from pipeline import PDFValidationError, validate_and_store_pdf


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


if __name__ == "__main__":
    unittest.main()
