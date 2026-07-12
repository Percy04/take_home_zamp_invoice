# Submission checklist

- `npm ci`, `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build` pass.
- `npm run build:demo-data` succeeds without Python.
- Production starts as one process and `/api/health` reports database availability.
- Persistent disk is mounted at `RUNTIME_DIR`; reset and restart preserve the expected behavior.
- Recorded mode completes all fixtures without provider credits; live mode is opt-in.
- No `.env`, credentials, runtime database, uploads, or real financial documents are committed.
- Private-browser rehearsal follows `docs/DEMO_REHEARSAL.md` in under five minutes.
