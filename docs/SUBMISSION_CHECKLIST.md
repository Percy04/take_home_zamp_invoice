# Submission checklist

- `npm ci`, `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build` pass.
- `npm run build:demo-data` succeeds without Python.
- Production starts as one process and `/api/health` reports database availability.
- Persistent disk is mounted at `RUNTIME_DIR`; reset and restart preserve the expected behavior.
- Production uses live providers; recorded mode completes fixtures only in automated tests and local offline development.
- Creating a run returns `PROCESSING` immediately, polling reaches the persisted outcome, and review decisions use only `POST /api/runs/:runId/review`.
- An idempotency-key retry does not duplicate provider or ledger work; reset rejects while in-process work is active.
- No `.env`, credentials, runtime database, uploads, or real financial documents are committed.
- Private-browser rehearsal follows `docs/DEMO_REHEARSAL.md` in under five minutes.
