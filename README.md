# AP Resolution Agent

A full-stack TypeScript demo that extracts invoice evidence, applies deterministic AP controls, and either posts once to a synthetic ledger or blocks for review.

The demo includes PDF intake, Azure evidence extraction, selectable OpenAI or Gemini structured source mapping, deterministic AP controls, reviewer confirmation, atomic SQLite posting, dashboard history, and durable run URLs. Every application run uses live providers. The canonical architecture and delivery contract is in [BUILD_SPEC_TYPESCRIPT.md](BUILD_SPEC_TYPESCRIPT.md); [BUILD_SPEC.md](BUILD_SPEC.md) remains the detailed business-rule and fixture contract.

## Setup

Node.js 24.18.0 and npm 11.12.1 are the committed baseline.

```powershell
npm ci
Copy-Item .env.example .env
```

Configure Azure credentials, choose `MAPPING_PROVIDER=openai` or `gemini`, and configure that mapper's key. Development, staging, and production fail fast without them; live provider calls may incur cost.

Run the Vite client and Express API in separate terminals:

```powershell
npm run dev
npm run dev:server
```

## Verification

```powershell
npm run typecheck
npm test
npm run lint
npm run build
npm run build:demo-data
npm run verify:live -- data/fixtures/happy.pdf
$env:NODE_ENV = "production"
npm start
```

## Manual pipeline workbook

Run a local sample PDF through live providers without changing the normal runtime database:

```powershell
npm run pipeline:workbook -- --fixture happy --step extract
npm run pipeline:workbook -- --fixture happy --step normalize
npm run pipeline:workbook -- --fixture happy --step controls
npm run pipeline:workbook -- --fixture happy --step run
npm run pipeline:workbook -- --fixture missing_po --step run --confirm PO-1002
npm run pipeline:workbook -- --file data/fixtures/02-Invoice-2.pdf --step run
```

Use `--file` for any PDF and `--fixture` to select a local sample PDF. `--step all` prints every stage; `--confirm` accepts a candidate PO number or bundle candidate ID after a review state. This always calls live providers, requires credentials, and may incur cost.

The production server exposes the client at `http://localhost:3000` and readiness at `http://localhost:3000/api/health`.

## API

Creating a run with multipart `POST /api/runs` requires one `invoice` PDF, validates and stores it, starts live processing in the Node process, and immediately returns `201` with a `PROCESSING` run and its `Location`. The UI polls `GET /api/runs/:runId`; there is no process endpoint.

The product endpoints are `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:runId`, `GET /api/runs/:runId/document`, and `POST /api/runs/:runId/review`. Listing always returns newest-first `{ "items": [...] }` and rejects query parameters. Review uses one strict payload: `confirm_po` with `poNumber`, `reject_po`, `confirm_bundle` with `candidateId`, or `reject_bundle`. `GET /api/health` and demo-only guarded `POST /api/reset` remain available.

Development and test assets:

- `data/fixtures/`: acceptance and regression PDFs for automated uploads and intentional manual live tests.
- `tests/fixtures/recordings/`: recorded Azure responses and normalized source catalogues used only by automated tests.
- `data/seed.sqlite`: immutable seed database.
- `data/cases.json`: exact expected outcomes and accounting deltas.

`npm run build:demo-data` materializes the canonical synthetic test data into `tmp/demo-data` using TypeScript. It regenerates digital PDFs from `cases.json`, retains the committed image-only scan baseline, copies the immutable seed, and emits matching hashes.

Deployment and rehearsal instructions are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/DEMO_REHEARSAL.md](docs/DEMO_REHEARSAL.md), and [docs/SUBMISSION_CHECKLIST.md](docs/SUBMISSION_CHECKLIST.md).
The latest paid-provider results and remaining scanned-input limitation are recorded in [docs/LIVE_VERIFICATION.md](docs/LIVE_VERIFICATION.md).
