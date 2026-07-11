# AP Resolution Agent

A full-stack TypeScript demo that extracts invoice evidence, applies deterministic AP controls, and either posts once to a synthetic ledger or blocks for review.

Phase 0 provides the strict TypeScript workspace, shared Zod contracts, validated server environment, Express health API, and React application shell. The canonical architecture and delivery contract is in [BUILD_SPEC_TYPESCRIPT.md](BUILD_SPEC_TYPESCRIPT.md); [BUILD_SPEC.md](BUILD_SPEC.md) remains the detailed business-rule and fixture contract.

## Setup

Node.js 24.18.0 and npm 11.12.1 are the committed baseline.

```powershell
npm ci
Copy-Item .env.example .env
```

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
$env:NODE_ENV = "production"
npm start
```

The production server exposes the client at `http://localhost:3000` and readiness at `http://localhost:3000/api/health`.

Preserved deterministic assets:

- `data/fixtures/`: nine acceptance and regression invoice PDFs.
- `data/recordings/`: recorded Azure responses and normalized source catalogues for offline tests.
- `data/seed.sqlite`: immutable seed database.
- `data/cases.json`: exact expected outcomes and accounting deltas.
