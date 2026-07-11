import unittest
from pathlib import Path

from streamlit.testing.v1 import AppTest


class AppSmokeTests(unittest.TestCase):
    def test_unified_dashboard_is_runnable(self):
        app = AppTest.from_file(Path(__file__).resolve().parents[1] / "app.py").run()

        self.assertEqual(app.exception, [])
        self.assertEqual(app.tabs, [])
        self.assertEqual(app.title[0].value, "Invoices, decisions, and evidence")
        self.assertEqual(
            [heading.value for heading in app.subheader],
            [
                "Process a new invoice",
                "Recent runs",
                "How a run is decided",
                "Responsibility split",
            ],
        )
        self.assertEqual(app.selectbox[0].label, "Try a fixture")
        self.assertEqual(app.button[0].label, "Run invoice")


if __name__ == "__main__":
    unittest.main()
