# AP Resolution Agent

A full-stack TypeScript demo that extracts invoice evidence, applies deterministic AP controls, and either posts once to a synthetic ledger or blocks for review.

The demo includes PDF intake, Azure evidence extraction, selectable OpenAI or Gemini structured source mapping, deterministic AP controls, reviewer confirmation, atomic SQLite posting, dashboard history, durable run URLs, and recorded offline fixtures. The canonical architecture and delivery contract is in [BUILD_SPEC_TYPESCRIPT.md](BUILD_SPEC_TYPESCRIPT.md); [BUILD_SPEC.md](BUILD_SPEC.md) remains the detailed business-rule and fixture contract.

## Setup

Node.js 24.18.0 and npm 11.12.1 are the committed baseline.

```powershell
npm ci
Copy-Item .env.example .env
```

The default `PROVIDER_MODE=recorded` uses committed evidence and consumes no Azure, OpenAI, or Gemini credits. For uploaded live PDFs, set `PROVIDER_MODE=live`, Azure credentials, choose `MAPPING_PROVIDER=openai` or `gemini`, and configure only that mapper's key.

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

The production server exposes the client at `http://localhost:3000` and readiness at `http://localhost:3000/api/health`.

Preserved deterministic assets:

- `data/fixtures/`: nine acceptance and regression invoice PDFs.
- `data/recordings/`: recorded Azure responses and normalized source catalogues for offline tests.
- `data/seed.sqlite`: immutable seed database.
- `data/cases.json`: exact expected outcomes and accounting deltas.

`npm run build:demo-data` materializes the canonical synthetic data into `tmp/demo-data` using TypeScript. It regenerates digital PDFs from `cases.json`, retains the committed image-only scan baseline, copies the immutable seed, and emits matching hashes.

Deployment and rehearsal instructions are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/DEMO_REHEARSAL.md](docs/DEMO_REHEARSAL.md), and [docs/SUBMISSION_CHECKLIST.md](docs/SUBMISSION_CHECKLIST.md).
The latest paid-provider results and remaining scanned-input limitation are recorded in [docs/LIVE_VERIFICATION.md](docs/LIVE_VERIFICATION.md).
