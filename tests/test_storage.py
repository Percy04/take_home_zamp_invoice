import sqlite3
import tempfile
import unittest
from pathlib import Path

from storage import initialize_runtime_database


class RuntimeDatabaseTests(unittest.TestCase):
    def test_initializes_once_from_seed(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime_path = Path(directory) / "runtime.db"

            initialized = initialize_runtime_database(runtime_path)
            with sqlite3.connect(initialized) as connection:
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                connection.execute(
                    "INSERT INTO runs (id, created_at, updated_at, filename, file_sha256, state, stage_events_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("RUN-1", "2026-07-11T00:00:00Z", "2026-07-11T00:00:00Z", "invoice.pdf", "abc", "PROCESSING", "[]"),
                )
                connection.commit()

            initialize_runtime_database(runtime_path)
            with sqlite3.connect(runtime_path) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
