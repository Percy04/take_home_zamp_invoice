# AP Resolution Agent — TypeScript Web Application Build Specification

This specification translates the product, control, persistence, fixture, and acceptance contract in `BUILD_SPEC.md` into a conventional full-stack TypeScript application. Unless this document explicitly changes a rule, the deterministic business behavior, reason codes, seed data, and nine fixture outcomes in `BUILD_SPEC.md` remain authoritative.

## 1. Product contract

Build a polished public web demo that accepts an invoice PDF, extracts evidence, compares it with synthetic purchase-order and receipt data, applies deterministic AP controls, and produces one of two decisions:

- `AUTO_CLEARED`: every required control passed and the invoice was posted exactly once to the demo ledger.
- `NEEDS_REVIEW`: posting was blocked, with a stable reason code, supporting evidence, and a concrete next action.

The primary audience is a non-technical AP buyer. The application must make the workflow, evidence, controls, decision, and accounting effects easy to understand without exposing raw provider payloads or requiring the user to inspect JSON.

The application is an evaluation demo, not a production accounting system. It remains single-user, resettable, synchronous, USD-only, and intentionally narrow.

### Committed scope

- React user interface with responsive, accessible, company-facing presentation.
- Express REST API written in TypeScript.
- One synchronous PDF-to-decision workflow.
- PDF input up to 10 MiB and 10 pages.
- Digital and high-quality scanned invoice PDFs.
- One Azure Document Intelligence extraction call per processing attempt.
- At most one OpenAI structured mapping call, with one retry for transient or malformed responses.
- Server-owned TypeScript parsing, decimal arithmetic, matching, controls, decisions, and posting.
- SQLite persistence for runs, evidence, checks, candidates, ledger entries, and allocations.
- Missing-PO and unknown-bundle reviewer confirmation on the same run.
- The nine deterministic fixtures and outcomes defined in the original contract.
- Real processing stages persisted by the server and displayed by the client.
- One Node.js deployment serving the compiled React application and REST API.

### Success criteria

- A real uploaded digital or scanned PDF travels through Azure extraction, OpenAI source mapping, deterministic controls, and a persisted outcome.
- The browser calls the Express API; it never calls Azure, OpenAI, or SQLite directly.
- Provider credentials and accounting rules never ship in the client bundle.
- Equivalent business values across materially different layouts normalize to equivalent invoice data and decisions.
- The happy path posts exactly once.
- Blocked and awaiting-review outcomes create no accounting mutation.
- Reviewer confirmation reruns all required mutable controls and posts at most once.
- Refreshing or reopening a run URL restores persisted state.
- Processing indicators reflect persisted server work; there are no fake sleeps or simulated completion stages.
- A reviewer can understand the evidence, comparisons, controls, decision, and ledger effects without opening raw JSON.
- Reset restores the exact committed seed baseline.

### Non-goals

The non-goals in `BUILD_SPEC.md` remain unchanged, including authentication, multi-tenancy, real ERP integrations, queues, background workers, approval routing, multiple currencies, fuzzy matching, and production durability. Additionally:

- No microservices or independently deployed frontend and API.
- No GraphQL.
- No WebSocket infrastructure.
- No ORM or repository framework.
- No Redux or general-purpose global client store.
- No generated API client or schema registry.
- No server-side rendering requirement; the application is an authenticated-free client application served as static assets by Express.

## 2. Architecture

### Runtime shape

```text
Browser
  React + TanStack Query
       |
       | HTTPS JSON/multipart REST calls
       v
Express server
  routes -> pipeline -> controls -> storage
                 |          |          |
                 |          |          +-> SQLite
                 |          +-> deterministic TypeScript
                 +-> Azure Document Intelligence
                 +-> OpenAI
```

This is one application with two runtime boundaries: an untrusted browser client and a trusted Node.js server. Express serves both `/api/*` and the compiled client assets in production. Shared Zod schemas define the API contract without creating a separately published package.

### Technology choices

- Node.js 24.18.0 LTS and npm 11.12.1.
- TypeScript with `strict: true`.
- React and Vite for the browser application.
- React Router for `/`, `/dashboard`, and `/runs/:runId`.
- Express for the REST API and production static-file serving.
- TanStack Query for server state, polling, and mutation invalidation.
- Tailwind CSS for styling; use ordinary CSS where it is clearer.
- Zod for environment, API, provider-boundary, and persisted-JSON validation.
- `decimal.js` for all quantities, money, rates, tolerances, and allocation arithmetic.
- `better-sqlite3` for synchronous SQLite transactions and queries.
- `multer` with memory storage and strict upload limits.
- The Azure Document Intelligence REST client and OpenAI JavaScript SDK for provider calls.
- `pdf-lib` for PDF intake checks and deterministic fixture generation.
- `react-pdf`/PDF.js for browser PDF preview.
- Vitest, React Testing Library, and Supertest.
- ESLint with the TypeScript and React recommended rule sets.
- Prettier for mechanical formatting.

### Exact package baseline

The following newest mutually compatible stable versions were verified from the npm registry on 2026-07-11. Use exact versions without `^` or `~`, commit `package-lock.json`, and install in CI and deployment with `npm ci`. Do not substitute prerelease packages for stable releases. Compatibility takes precedence over choosing a newer isolated version: TypeScript 7.0.2 is intentionally not used because `typescript-eslint` 8.63.0 supports TypeScript versions below 6.1.0.

Runtime dependencies:

| Package                                |   Version |
| -------------------------------------- | --------: |
| `react`                                |  `19.2.7` |
| `react-dom`                            |  `19.2.7` |
| `react-router-dom`                     |  `7.18.1` |
| `@tanstack/react-query`                | `5.101.2` |
| `express`                              |   `5.2.1` |
| `zod`                                  |   `4.4.3` |
| `multer`                               |   `2.2.0` |
| `decimal.js`                           |  `10.6.0` |
| `better-sqlite3`                       | `12.11.1` |
| `@azure-rest/ai-document-intelligence` |   `1.1.0` |
| `@azure/core-auth`                     |  `1.10.1` |
| `openai`                               |  `6.46.0` |
| `pdf-lib`                              |  `1.17.1` |
| `react-pdf`                            |  `10.4.1` |
| `helmet`                               |   `8.2.0` |
| `express-rate-limit`                   |   `8.5.2` |
| `cors`                                 |   `2.8.6` |
| `dotenv`                               |  `17.4.2` |

Development dependencies:

| Package                       |   Version |
| ----------------------------- | --------: |
| `typescript`                  |   `6.0.3` |
| `vite`                        |   `8.1.4` |
| `@vitejs/plugin-react`        |   `6.0.3` |
| `tailwindcss`                 |   `4.3.2` |
| `@tailwindcss/vite`           |   `4.3.2` |
| `tsx`                         |  `4.23.0` |
| `vitest`                      |  `4.1.10` |
| `@vitest/coverage-v8`         |  `4.1.10` |
| `jsdom`                       |  `29.1.1` |
| `@testing-library/react`      |  `16.3.2` |
| `@testing-library/dom`        |  `10.4.1` |
| `@testing-library/jest-dom`   |   `6.9.1` |
| `supertest`                   |   `7.2.2` |
| `eslint`                      |  `10.7.0` |
| `@eslint/js`                  |  `10.0.1` |
| `typescript-eslint`           |  `8.63.0` |
| `eslint-plugin-react-hooks`   |   `7.1.1` |
| `eslint-plugin-react-refresh` |   `0.5.3` |
| `prettier`                    |   `3.9.5` |
| `@types/node`                 | `24.13.3` |
| `@types/react`                | `19.2.17` |
| `@types/react-dom`            |  `19.2.3` |
| `@types/express`              |   `5.0.6` |
| `@types/multer`               |   `2.2.0` |
| `@types/better-sqlite3`       |  `7.6.13` |
| `@types/cors`                 |  `2.8.19` |
| `@types/supertest`            |   `7.2.0` |

“Latest” means the latest stable version at the recorded baseline, not an unbounded install instruction. Upgrade intentionally with a separate dependency change that runs type checking, tests, linting, and the production build before updating the lockfile.

Do not add a second HTTP framework, ORM, DI container, service locator, event bus, job queue, monorepo orchestrator, component library, or form library unless an implemented requirement demonstrates the need.

### Repository shape

```text
client/
  src/
    app.tsx
    api.ts
    invoice-page.tsx
    dashboard-page.tsx
    run-page.tsx
    components/
  index.html

server/
  src/
    index.ts
    routes.ts
    pipeline.ts
    controls.ts
    providers.ts
    storage.ts
    schemas.ts

shared/
  contracts.ts

scripts/
  build-demo-data.ts
  verify-azure.ts

data/
  fixtures/
  recordings/
  seed.sqlite
  cases.json

tests/
  pipeline.test.ts
  storage.test.ts
  api.test.ts
  acceptance.test.ts

BUILD_SPEC_TYPESCRIPT.md
package.json
tsconfig.json
vite.config.ts
vitest.config.ts
.env.example
README.md
```

Files may remain larger when their behavior changes together. Split a component or server module only when it has a distinct boundary, substantial independent logic, or focused tests that are materially clearer after extraction. Avoid barrel files and one-function wrapper modules.

### Dependency direction

- `client` may import only browser-safe code and `shared/contracts.ts`.
- `shared` contains serializable API schemas, enums, and inferred types. It must not import server or browser modules.
- Express routes validate transport input, call one application operation, and translate its result to HTTP. They do not contain accounting logic.
- `pipeline.ts` owns workflow orchestration.
- `controls.ts` owns pure deterministic normalization, matching, and decision functions.
- `providers.ts` is the only module that imports Azure or OpenAI SDKs.
- `storage.ts` is the only module that opens SQLite or manages transactions.
- Server modules must never import client modules.

These are ownership boundaries, not layers that require an interface for every implementation.

### End-to-end flow

```text
Upload PDF
  -> POST /api/runs
  -> validate request and PDF
  -> store PDF and create PROCESSING run
  -> return run identity
  -> POST /api/runs/:runId/process
  -> execute Azure extraction
  -> build evidence catalogue
  -> execute OpenAI source mapping
  -> dereference and normalize in TypeScript
  -> resolve vendor and duplicate
  -> resolve PO or persist candidates
  -> normalize tax
  -> match direct lines or bundle components
  -> apply deterministic controls
  -> atomically post, await confirmation, or block
  -> persist final result
```

After run creation, the client starts `POST /api/runs/:runId/process` and polls `GET /api/runs/:runId` while that processing request is active. The process endpoint performs the workflow synchronously; polling uses separate HTTP requests and reads its persisted stages. Polling is preferred over WebSockets or SSE for this single-user demo. Stop polling when the run reaches `POSTED`, `AWAITING_PO_CONFIRMATION`, `AWAITING_BUNDLE_CONFIRMATION`, or `NEEDS_REVIEW`.

The persisted run is the source of truth. The client must tolerate a lost process response by refetching the run, and it may safely retry the idempotent process endpoint. Do not introduce a queue solely to make processing asynchronous.

### API conventions

- Base path: `/api`.
- Request and response media type: `application/json`, except PDF upload uses `multipart/form-data`.
- Identifiers are opaque UUID strings.
- Dates are `YYYY-MM-DD`.
- Timestamps are UTC ISO-8601 strings.
- Decimals cross the API as plain strings, never JSON numbers.
- Enums use the uppercase contract values in this specification.
- Successful creation returns `201`; successful reads and actions return `200`.
- Validation errors return `400`; missing resources return `404`; invalid run-state transitions return `409`; oversized uploads return `413`.
- Expected invoice/provider failures are persisted business outcomes and return a run representation, not an unhandled `500`.
- Unexpected failures return a stable safe error envelope and correlation/run ID without stack traces or provider messages.
- Every request body, path parameter, environment value, and provider response is validated at its trust boundary.
- Routes are versionless for this demo. Add versioning only if a second incompatible consumer exists.

Error envelope:

```ts
type ApiError = {
  error: {
    code: string;
    message: string;
    runId?: string;
  };
};
```

### REST endpoints

```text
POST   /api/runs
POST   /api/runs/:runId/process
GET    /api/runs?state=&limit=&cursor=
GET    /api/runs/:runId
GET    /api/runs/:runId/document
POST   /api/runs/:runId/confirm-po
POST   /api/runs/:runId/confirm-bundle
POST   /api/reset
GET    /api/health
```

`POST /api/runs`

- Accept one `invoice` PDF part or a committed `fixtureId`, never both.
- Apply upload size and MIME checks before pipeline execution.
- Validate and store the PDF, then create and persist the `PROCESSING` run before any provider call.
- Return `201` with the canonical run representation and `Location: /api/runs/:runId`.
- If the client retries with the same optional `Idempotency-Key`, return the original run rather than creating another processing attempt.

`POST /api/runs/:runId/process`

- Accept no request body.
- Execute the provider and deterministic workflow synchronously for the stored PDF.
- Return the final canonical run representation.
- Permit only a newly created `PROCESSING` run that has not completed provider work.
- A retry after completion returns the existing result. Concurrent processing attempts for the same run return `409` or join the existing attempt; they must never duplicate provider calls or posting.

`GET /api/runs`

- Return newest-first run summaries.
- Support state filtering and bounded cursor pagination.
- Default and maximum page size are 25 and 100.

`GET /api/runs/:runId`

- Return the canonical run detail, including stages, invoice evidence, candidates, comparisons, checks, decision, execution, and ledger effects.
- The client treats this representation as server state and does not copy it into a second global store.

`GET /api/runs/:runId/document`

- Stream only the PDF stored for that run.
- Set `Content-Type: application/pdf`, `Content-Disposition: inline`, and `X-Content-Type-Options: nosniff`.
- Never construct the path from user input; resolve it from the persisted run ID.

`POST /api/runs/:runId/confirm-po`

```json
{ "poNumber": "PO-1002" }
```

- Accept only a PO candidate stored on the same awaiting run.
- Resume the same run, rerun every required PO-dependent and mutable control, and post at most once.

`POST /api/runs/:runId/confirm-bundle`

```json
{ "candidateId": "opaque-id" }
```

- Accept only a bundle candidate stored on the same awaiting run.
- Resume the same run, revalidate against current state, and post at most once.

`POST /api/reset`

- Restore the seed database and remove temporary uploads.
- Disable or protect this route outside the intentionally public demo configuration.
- Reject reset while a run is actively writing.

`GET /api/health`

- Report application readiness and database availability.
- Do not call Azure or OpenAI and do not expose configuration values.

### Server operations

```ts
processInvoice(input: {
  runId: string;
  bytes: Buffer;
  filename: string;
}): Promise<ProcessResult>

resumeWithPo(runId: string, poNumber: string): Promise<ProcessResult>

resumeWithBundle(runId: string, candidateId: string): Promise<ProcessResult>

postInvoice(runId: string, evaluation: Evaluation): string

resetDemo(): void
```

`postInvoice` executes inside one `better-sqlite3` transaction. It rechecks duplicate and mutable capacity controls, inserts the ledger invoice and allocations, updates the run to `POSTED`, and returns the ledger ID. It is idempotent by run ID.

### Shared contracts

Use Zod as the runtime source of truth and infer TypeScript types with `z.infer`. Do not maintain separate hand-written interfaces that can drift.

The canonical domain contracts remain those in `BUILD_SPEC.md`:

- `InvoiceMapping` and `InvoiceLineMapping`
- `NormalizedInvoice` and `NormalizedInvoiceLine`
- `SourceRef`
- `CheckResult`
- `POCandidate`
- `BundleCandidate` and `BundleComponent`
- `MatchAllocation`
- `StageEvent`
- `ProcessResult`
- `RunState`, `Decision`, `Execution`, `TaxTreatment`, `PriceBasis`, and `MatchType`

Represent decimal fields as `Decimal` inside the server and decimal strings in SQLite JSON and API contracts. Convert at explicit persistence and transport boundaries.

Use discriminated unions where state changes the permitted data. For example, an awaiting-PO result must have PO candidates, while a posted result must have a ledger ID. Zod refinements must reject impossible combinations.

### Azure and OpenAI boundary

Azure receives the uploaded PDF bytes through the prebuilt-invoice model. Convert its result into the same compact `SourceRef` catalogue defined in the original specification. Azure evidence is never a decision.

Only the compact source catalogue reaches OpenAI. The original PDF does not. OpenAI returns source IDs using a Zod-backed structured response. It may locate evidence but must not rewrite values, infer tax, invent bundle components, select a final PO, approve aliases, decide controls, or post.

Conceptual call shape:

```ts
const response = await openai.responses.parse({
  model: env.OPENAI_MODEL,
  input: [systemPrompt, evidencePrompt],
  text: { format: zodTextFormat(invoiceMappingSchema, "invoice_mapping") },
});
```

The server validates every returned source ID against the catalogue before dereferencing. Unknown IDs, refusal, timeout, malformed output, or empty output produce `NEEDS_REVIEW / MAPPING_FAILED`.

Provider timeouts, retry limits, safe error conversion, evidence rules, and logging restrictions remain exactly as defined in the original contract. Use `AbortSignal.timeout` or an equivalent SDK-supported signal. Do not log request bodies, invoice text, API keys, raw provider payloads, or stack traces to the browser.

## 3. Deterministic behavior

Every deterministic rule in Sections 3 and 4 of `BUILD_SPEC.md` remains unchanged and must be ported directly to TypeScript. This includes:

- PDF validation and safe temporary storage.
- NFKC text normalization.
- exact money, quantity, currency, and date parsing.
- required evidence and confidence thresholds.
- unsupported-structure detection.
- separate and inclusive tax normalization.
- vendor, duplicate, PO, direct-line, and bundle resolution.
- candidate bounds and deterministic ordering.
- price, quantity, receipt, and value controls.
- check precedence and primary reason selection.
- decision/execution/state invariants.
- atomic posting and allocation behavior.
- all stable reason codes and next actions.

Implementation constraints:

- Never use JavaScript `number` for financial or quantity calculations.
- Parse selected values directly into `Decimal` after normalization.
- Quantize money to `0.01` with half-up rounding at the same points as the original contract.
- Compare absolute `Decimal` differences.
- Use stable explicit comparators for every candidate sort; never depend on database or object iteration order.
- Never branch on fixture filename, fixture ID, or file hash.
- Keep pure control functions free of Express, database, and provider dependencies.
- Validate the final `ProcessResult` before persistence and before returning it through the API.

## 4. Persistence

The SQLite schema, constraints, seed rows, reset behavior, transaction boundaries, and table semantics in Section 5 of `BUILD_SPEC.md` remain authoritative.

### Runtime database

- `data/seed.sqlite` is immutable and committed.
- The writable runtime database lives outside the client assets in a configured persistent runtime directory.
- On first start, copy the seed only when the runtime database is absent.
- In production, the Node process must run on a host with a persistent volume.
- Never deploy this SQLite design to an ephemeral or horizontally scaled serverless filesystem.
- Open one application-owned `better-sqlite3` connection, enable foreign keys, configure a busy timeout, and use WAL only when compatible with the mounted filesystem.

### Transaction rules

- Use explicit SQLite transactions for posting, allocation, confirmation-state changes, and reset coordination.
- Recheck duplicate and mutable capacity inside the posting transaction.
- Enforce idempotency and uniqueness with database constraints, not only application checks.
- Convert expected uniqueness conflicts into the stable persisted business outcome.
- A failed write must leave ledger, allocations, capacities, and run state at their pre-transaction values.
- Do not hold a transaction open while calling Azure or OpenAI.

### Stored JSON

Validate JSON when writing and when reading it back. Store decimals as strings and timestamps as UTC ISO strings. Preserve observed and derived values separately. Raw provider payload recordings remain test-only and are never selected by live file hash.

## 5. Client application

### Routes

- `/`: process an invoice and show the active result.
- `/dashboard`: metrics, filters, and chronological run history.
- `/runs/:runId`: durable run detail and allowed reviewer action.

Use route parameters for durable identity and query parameters for shareable filters. Do not store server records in local storage.

### Processing page

- Drag-and-drop/file-picker upload and fixture selector.
- Client-side file size/type feedback for usability; the server repeats all validation.
- Privacy notice explaining that the PDF goes to Azure and extracted evidence goes to OpenAI.
- Real stage timeline driven by the persisted run representation.
- Clear idle, uploading, processing, awaiting-review, posted, blocked, configuration-error, and unexpected-error states.
- Original PDF preview.
- Observed invoice values beside normalized values.
- Source location and confidence presentation.
- Direct and bundle invoice-to-PO comparison tables.
- Check results, primary reason, next action, ledger ID, and capacity deltas.

### Dashboard and run detail

- Total runs, posted count, review count, and demo auto-clear rate.
- Newest-first history with state filter and pagination.
- Persisted stage timeline and evidence.
- Mutually exclusive PO or bundle confirmation control when allowed by run state.
- Confirmation buttons disable while submitting and cannot produce duplicate actions.
- After mutation, invalidate and refetch the canonical run query.

### UI conventions

- Prefer semantic HTML before custom interactive elements.
- Every input has a visible label; keyboard focus is visible.
- Color never carries status meaning by itself.
- Tables remain readable on narrow screens through deliberate responsive layouts.
- Loading states preserve layout and communicate real activity.
- Error messages explain the next useful action without exposing implementation details.
- Use one visual system for spacing, typography, color, status, and surfaces.
- Extract a component when it has meaningful behavior, substantial markup, or multiple consumers—not merely to shorten a page file.
- TanStack Query owns remote server state. Component state owns only temporary UI decisions such as the selected file or open panel.

## 6. Security and reliability

- Secrets exist only in server environment variables validated at startup.
- Vite-exposed environment variables must contain no secrets.
- Restrict uploads to one file, 10 MiB, and PDF acceptance rules.
- Generate storage names from run IDs, never submitted filenames.
- Set Helmet security headers and a Content Security Policy compatible with the PDF viewer.
- Configure CORS only in development when Vite and Express use different origins; production is same-origin.
- Apply a modest rate limit to upload, confirmation, and reset routes for the public demo.
- Never render provider or invoice text as HTML.
- Return safe errors and retain detailed diagnostics only in server-side development logs with invoice content redacted.
- Gracefully close the HTTP server and SQLite connection on termination.
- Reject startup when required configuration is absent, while allowing deterministic tests to inject recorded providers.

Authentication remains out of scope. Therefore the public demo must contain synthetic data only, state this limitation visibly, and expose no real financial documents.

## 7. Seed and fixture contract

All vendors, purchase orders, bundle definitions, ledger baseline rows, fixture contents, expected normalized values, decisions, allocations, capacities, and same-run confirmation behavior in Section 6 of `BUILD_SPEC.md` remain unchanged.

The TypeScript fixture generator must reproduce the canonical nine PDFs, `seed.sqlite`, and `cases.json` deterministically. Existing fixture artifacts may be retained during migration as the behavioral baseline. Regeneration must not silently change their semantics.

Fixtures:

1. `happy.pdf`
2. `duplicate.pdf`
3. `missing_po.pdf`
4. `receipt_capacity.pdf`
5. `happy_layout_b.pdf`
6. `happy_layout_c_scanned.pdf`
7. `bundle_known.pdf`
8. `bundle_unknown.pdf`
9. `tax_inclusive.pdf`

## 8. Implementation phases

### Phase 0 — TypeScript foundation and contract preservation

- Add the TypeScript workspace, strict compiler configuration, formatting, linting, and test commands.
- Preserve the existing canonical fixture files, provider recordings, seed database, and case expectations.
- Implement shared Zod schemas for API representations and persisted JSON.
- Implement environment validation.
- Add a minimal Express server, health endpoint, Vite client, and production static serving.
- Prove one Supertest API request and one rendered React page.

Exit gate:

- `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build` pass.
- Express serves the production client and `/api/health` from one Node process.

### Phase 1 — Happy-path vertical slice

- Implement runtime database initialization.
- Implement PDF upload, validation, and safe storage.
- Port Azure evidence catalogue generation.
- Port OpenAI structured source mapping.
- Port normalization, direct matching, minimum controls, and atomic posting.
- Persist real stage events and expose run APIs.
- Build the processing page, polling, evidence, comparison, and decision views.

Exit gate:

- Reset, upload `happy.pdf`, observe real stages, receive `AUTO_CLEARED`, and see exactly one ledger post.
- Refreshing `/runs/:runId` restores the complete result.

### Phase 2 — Complete controls and idempotency

- Port every deterministic rule and stable reason code.
- Port inclusive-tax handling and trusted-bundle expansion.
- Complete transaction rollback, duplicate constraints, and request/run idempotency.
- Show observed versus normalized financial values and allocation evidence.

Exit gate:

- Pure control tests cover all committed boundaries.
- Blocked outcomes produce zero accounting mutations.
- Inclusive tax and trusted bundle fixtures post with the exact expected allocations.

### Phase 3 — Reviewer resolution

- Port deterministic PO and unknown-bundle candidate generation and persistence.
- Implement confirmation endpoints and mutually exclusive controls.
- Resume the same run and rerun current-state controls.
- Prevent repeated confirmation from creating another ledger effect.

Exit gate:

- Missing-PO and unknown-bundle scenarios await confirmation, then post once on the same run.
- Duplicate and receipt-capacity scenarios remain blocked without mutation.

### Phase 4 — Product-quality UI and reliability

- Complete dashboard, run history, filters, run detail, PDF preview, responsive layout, and accessibility pass.
- Add provider timeouts, safe failure conversion, rate limits, security headers, configuration states, and privacy copy.
- Verify scanned PDF and layout equivalence using live and recorded provider responses.

Exit gate:

- A non-technical reviewer can understand every fixture without JSON.
- All nine fixture scenarios pass from fresh resets.
- No secret, raw provider error, traceback, or unsafe HTML reaches the client.

### Phase 5 — Deployment and submission

- Deploy the compiled client and Express server as one Node.js application with persistent SQLite storage.
- Configure secrets only in the host environment.
- Verify cold start, reset, PDF streaming, refresh recovery, and all fixture workflows.
- Document local setup, scripts, architecture, privacy boundary, deployment, assumptions, and limitations.
- Rehearse the five-minute demonstration from the original specification using the polished web UI.

Exit gate:

- The public URL works in a private browser.
- API and client are same-origin in production.
- Reset restores the exact baseline.
- The recorded demonstration is under five minutes.

## 9. Verification

Standard commands:

```bash
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

### Test layers

- Pure Vitest tests for normalization, arithmetic, matching, candidates, checks, and state invariants.
- Storage tests against a temporary copied seed database.
- Supertest API tests for validation, status codes, error envelopes, idempotency, and confirmation transitions.
- React Testing Library tests for critical upload, processing, review, and error states.
- Acceptance tests using recorded Azure evidence and deterministic OpenAI mappings.
- Opt-in live provider smoke tests that never run in the default deterministic suite.

All unit and fixture assertions listed in Section 8 of `BUILD_SPEC.md` remain required. Port them by behavior; do not mechanically assert implementation structure.

### Additional web acceptance checks

- Browser code contains no Azure or OpenAI credentials.
- Uploaded bytes reach Express and Azure; the browser never sends provider requests.
- API decimal fields are strings.
- Invalid API bodies and illegal transitions are rejected consistently.
- Polling stops at terminal or awaiting-confirmation states.
- Refreshing a run URL restores persisted state.
- Duplicate submit and confirmation actions remain idempotent.
- PDF responses use safe headers and cannot escape the runtime upload directory.
- Express serves the built SPA and preserves client-side routing through a safe HTML fallback that excludes `/api/*`.
- Production works as one process against a persistent volume.

## 10. Definition of done

The project is complete when:

- All nine canonical fixtures satisfy their exact original outcomes.
- The full implementation is TypeScript; Python is not required to build, test, generate fixtures, or run the application.
- React communicates exclusively through the Express REST API.
- Azure and OpenAI integrations are server-only and evidence-bounded.
- Financial decisions remain deterministic, decimal-safe, auditable, and idempotent.
- The UI is responsive, accessible, visually coherent, and legible to a non-technical AP reviewer.
- Tests, type checking, linting, production build, and production startup pass.
- One Node application serves both the API and compiled frontend.
- The deployment uses persistent storage and contains synthetic demo data only.
