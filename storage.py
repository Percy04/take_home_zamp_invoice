"""SQLite runtime storage for the resettable demo."""

from pathlib import Path
import shutil
import tempfile


ROOT = Path(__file__).resolve().parent
SEED_PATH = ROOT / "data" / "seed.sqlite"
DEFAULT_RUNTIME_PATH = (
    Path(tempfile.gettempdir()) / "zamp-ap-resolution-demo" / "runtime.db"
)


def initialize_runtime_database(
    runtime_path: Path = DEFAULT_RUNTIME_PATH, seed_path: Path = SEED_PATH
) -> Path:
    """Copy the immutable seed only when the runtime database is absent."""
    if not runtime_path.exists():
        runtime_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(seed_path, runtime_path)
    return runtime_path
