# Live provider verification

Verified on 2026-07-12 with Azure Document Intelligence and the configured OpenAI mapper.

## Digital invoice

`npm run verify:live -- data/fixtures/happy.pdf`

- Azure extraction: passed
- OpenAI source mapping: passed
- Evidence records: 125
- Mapped lines: 2
- Deterministic normalization: passed
- Result: Acme Industrial Supplies LLC, ACME-2026-001, PO-1001, USD 990.00

## Scanned invoice

`npm run verify:live -- data/fixtures/happy_layout_c_scanned.pdf`

- Azure extraction: passed
- OpenAI source mapping: passed
- Evidence records: 81
- Mapped lines: 2
- Deterministic normalization: currently blocked by `MISSING_REQUIRED_FIELD`

During diagnosis, low-confidence structured Azure fields were safely replaced only when an exact, unique, higher-confidence table or key-value equivalent existed. The remaining failure is a required value that does not satisfy deterministic parsing. Field-specific parser diagnostics are now implemented so the next intentionally paid run will identify the exact field. Further paid retries were stopped to avoid unnecessary provider spend.

Recorded-mode acceptance for the scanned fixture remains passing. Do not describe the scanned live path as accepted until the live command completes successfully.
