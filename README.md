# AP Resolution Agent

A resettable Streamlit demo that extracts invoice evidence, applies deterministic
AP controls, and either posts once to a synthetic ledger or blocks for review.

Phase 0 and 0B freeze the contract and create deterministic fixtures. The application
pipeline begins in Phase 1; see [BUILD_SPEC.md](BUILD_SPEC.md).

## Setup

Python 3.12 is required.

```powershell
uv venv --python 3.12 .venv
.\.venv\Scripts\Activate.ps1
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
Copy-Item .env.example .env
```

Add Azure credentials to `.env`, then reproduce and validate Phase 0:

```powershell
python scripts/build_demo_data.py
python scripts/verify_azure.py
```

The Azure command submits the local happy-path PDF bytes to `prebuilt-invoice`,
checks fields/items/tables/confidence/source locations, and records the response
at `tests/recordings/happy_azure.json` for future offline tests.

## Phase 0 artifacts

- `data/fixtures/`: nine deterministic PDFs, including alternate layouts, an image-only scan, bundles, and inclusive tax.
- `data/seed.sqlite`: immutable source database for future runtime copies.
- `data/cases.json`: exact expected outcome and accounting deltas per case.
- `tests/recordings/*_azure.json`: recorded live Azure responses for the baseline and Phase 0B cases.
