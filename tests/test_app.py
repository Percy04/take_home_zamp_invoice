import unittest
from pathlib import Path

from streamlit.testing.v1 import AppTest


class AppSmokeTests(unittest.TestCase):
    def test_process_invoice_screen_is_runnable(self):
        app = AppTest.from_file(Path(__file__).resolve().parents[1] / "app.py").run()

        self.assertEqual(app.exception, [])
        self.assertEqual(
            [tab.label for tab in app.tabs], ["Process Invoice", "Dashboard & Review"]
        )
        self.assertEqual(app.selectbox[0].label, "Try a fixture")
        self.assertEqual(app.button[0].label, "Run")


if __name__ == "__main__":
    unittest.main()
