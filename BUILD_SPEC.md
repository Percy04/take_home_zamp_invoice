# AP Resolution Agent — Canonical Build Specification

## 1. Product contract

### Goal

Build a public Streamlit demo that accepts an invoice PDF, extracts its evidence, compares it with synthetic purchase-order and receipt data, applies deterministic AP controls, and produces one of two decisions:

- AUTO_CLEARED: every required control passed and the invoice was posted exactly once to the demo ledger.
- NEEDS_REVIEW: posting was blocked, with a stable reason code, supporting evidence, and a concrete next action.

The primary audience is a non-technical AP buyer evaluating whether the agent is understandable, controlled, and useful. The application must expose what happened, why it happened, and whether any accounting state changed.

The Zamp invoice-processing article is a domain reference for the workflow shape only. This project does not claim the breadth, integrations, autonomy, or production readiness described in that article.

### Committed scope

- One synchronous PDF-to-decision workflow.
- PDF input up to 10 MB and 10 pages.
- Machine-readable and high-quality scanned invoice PDFs as acceptance targets.
- Multiple vendor layouts and labels normalized into one evidence-backed invoice model.
- One synthetic legal entity operating only in USD.
- Approved vendors and their aliases are pre-seeded.
- At most one purchase order per invoice.
- Itemized goods invoices and at most one bundled invoice line per invoice.
- Separate tax and explicitly evidenced tax-inclusive pricing, including line-specific rates when every line is unambiguous.
- Exact vendor, PO, SKU, description, and canonical-UOM matching.
- Trusted vendor bundle definitions for automatic one-to-many component expansion.
- Bounded, deterministic bundle-decomposition proposals for previously unknown bundles.
- One Azure Document Intelligence extraction call.
- At most one OpenAI structured mapping call.
- Python-owned parsing, arithmetic, matching, decisions, and posting.
- Two reviewer actions: confirm a stored candidate PO and confirm a stored unknown-bundle decomposition.
- Persisted run history, evidence, check results, and ledger effects.
- Nine deterministic fixtures: six primary capability demonstrations and three regression exceptions.
- A public, single-user, resettable Streamlit demo.

### Success criteria

- A real uploaded digital or image-only scanned PDF travels through Azure extraction, OpenAI source mapping, deterministic controls, and a persisted outcome.
- UI stages represent actual work; no fake sleeps or simulated progress.
- Equivalent business values across materially different layouts normalize to equivalent invoice data and decisions.
- The happy-path invoice posts exactly once.
- A known bundle expands from trusted master data, checks every component, and posts one allocation per component.
- An unknown bundle never auto-posts; a stored decomposition requires explicit confirmation and full revalidation on the same run.
- Explicit tax-inclusive evidence is normalized from observed gross amounts into deterministic net and tax values before PO comparison.
- Missing-PO resolution uses the same run, requires explicit confirmation, reruns all controls, and posts at most once.
- Duplicate and receipt-capacity cases never mutate ledger or allocation state.
- Every blocked result has a reason code, evidence, and next action.
- A reviewer can understand a result without opening raw JSON.
- Demo history survives normal Streamlit widget reruns.
- Reset restores the exact committed seed baseline.

### Non-goals

- Email or EDI ingestion.
- Standalone image, XML, spreadsheet, or portal ingestion; scanned inputs are accepted only when wrapped in a valid PDF.
- Real ERP, accounting, procurement, banking, or payment integrations.
- Authentication, authorization, multi-tenancy, or multi-user isolation.
- Approval routing, escalations, vendor outreach, or approver messaging.
- Contract retrieval, payment scheduling, or learned behavior.
- Multiple POs on one invoice.
- Credit notes, discounts, non-zero freight, retainage, progress billing, or other special charges.
- Multiple currencies or currency conversion.
- UOM quantity conversions.
- More than one bundled invoice line per invoice, overlapping bundle allocations, or many invoice lines consuming the same PO line.
- Unknown-bundle proposals with more than four component lines, more than ten eligible PO lines, non-integer component quantities, or non-EA component UOMs.
- Automatic bundle-definition creation or learning from reviewer choices.
- Bundle price tolerance beyond the $0.01 exact-reconciliation allowance.
- Tax-rate inference from invoice-versus-PO differences.
- TAX_INCLUSIVE PO price bases for auto-clear; all committed POs explicitly use TAX_EXCLUSIVE.
- Compound, exempt, withholding, reverse-charge, or tax-recoverability decisions.
- Unresolved mixtures of inclusive and exclusive lines or tax rates that cannot be associated with specific lines.
- Fuzzy semantic matching, near-duplicate detection, or automatic vendor-alias creation.
- Handwritten, severely blurred, damaged, or otherwise low-quality scans as an auto-clear acceptance target.
- Non-English acceptance coverage.
- Production durability or production accounting claims.
- Generic support for the existing progress-billing sample. It may remain a documented stretch input but is not an acceptance fixture.

## 2. System design

### End-to-end flow

The application executes this sequence synchronously:

    Validate PDF
      -> Create PROCESSING run
      -> Azure prebuilt-invoice OCR and extraction
      -> Build field, item, tax, table, OCR-line, and optional key-value evidence catalogue
      -> OpenAI structured source mapping
      -> Dereference observed values in Python
      -> Resolve vendor and duplicate
      -> Resolve or request confirmation of PO
      -> Normalize explicit separate or inclusive tax against the PO price basis
      -> Match direct lines or expand a trusted bundle
      -> Propose reviewer confirmation for an unknown bundle when possible
      -> Apply deterministic financial and capacity controls
      -> AUTO_CLEARED + atomic ledger post
         or NEEDS_REVIEW + blocked/awaiting outcome

Streamlit reports each completed stage through a real status container. The UI must not infer or display a stage as complete before its corresponding operation returns successfully.

### Runtime and dependencies

- Python 3.12.
- streamlit[pdf] 1.59.1.
- azure-ai-documentintelligence 1.0.2.
- openai 2.45.0.
- pydantic 2.13.4.
- python-dotenv 1.2.2.
- pypdf 6.14.2.
- reportlab 5.0.0.
- Python standard-library sqlite3, decimal, datetime, hashlib, json, pathlib, shutil, tempfile, unicodedata, uuid, and unittest.

Required secrets:

- AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
- AZURE_DOCUMENT_INTELLIGENCE_KEY
- OPENAI_API_KEY

Optional configuration:

- OPENAI_MODEL, default gpt-5.4-mini.

Local development reads .env. Streamlit deployment reads the same values from Streamlit secrets. Secrets, invoice content, source evidence, and raw provider payloads must not be printed to application logs.

### Lean repository shape

Keep runtime code in three modules:

- app.py: Process Invoice and Dashboard & Review tabs.
- pipeline.py: schemas, provider adapters, evidence catalogue, normalization, matching, controls, and orchestration.
- storage.py: runtime initialization, SQLite queries, reset, history, transactions, and posting.

Supporting artifacts:

- data/fixtures: the nine generated acceptance and regression PDFs.
- data/recordings: recorded Azure responses used only by tests.
- data/seed.sqlite: immutable committed seed database.
- data/cases.json: expected fixture outcomes and accounting deltas.
- scripts/build_demo_data.py: deterministic PDF and seed-data generator.
- tests/test_pipeline.py: standard-library unit and acceptance tests.
- requirements.txt, .env.example, README.md, and this specification.

Do not introduce service layers, repositories, dependency-injection frameworks, background workers, queues, or an ORM. sqlite3 and direct module functions are sufficient for this demo.

### AI boundary

Azure Document Intelligence receives the uploaded PDF bytes and uses the prebuilt-invoice model. The same call handles digital and image-only scanned PDFs. Azure may identify fields, nested tax details, line items, tables, OCR lines and words, optional key-value pairs, raw content, confidence, and source locations. Azure output is evidence, not a decision.

Convert the Azure result into a compact catalogue of SourceRef records. Stable identifiers follow these forms:

- field.<AzureFieldName>
- item.<item-index>.<AzureFieldName>
- tax.<tax-index>.<AzureFieldName>
- table.<table-index>.r<row-index>.c<column-index>
- line.<page-number>.l<line-index>
- key_value.<pair-index>.key
- key_value.<pair-index>.value

Each SourceRef contains:

- id: stable source identifier.
- content: exact Azure-observed text.
- confidence: Azure confidence from 0 through 1 when available, otherwise null.
- page: one-based page number when available.
- table_index, row, column, and line_index: nullable source coordinates.
- label: Azure field name or a compact source label.

OCR-line confidence is the minimum confidence of the Azure words overlapping that line. Key-value references are included only when Azure returns the optional key-value-pair feature. Only the compact source catalogue goes to OpenAI; the original PDF does not. The mapping call uses the Responses API structured-output parser:

    client.responses.parse(
        model=os.getenv("OPENAI_MODEL", "gpt-5.4-mini"),
        input=[system_prompt, evidence_prompt],
        text_format=InvoiceMapping,
    )

OpenAI is limited to selecting source IDs. It may locate a tax-inclusion statement or rate, but it must not rewrite observed values, infer a missing tax rate, decide gross-versus-net treatment, invent bundle components, choose component quantities, choose a final PO, approve an alias, decide a control, create master data, or post anything.

The mapping request has a 30-second timeout, one retry, and a 4,000-token output ceiling. A refusal, timeout, malformed structured response, empty response, or unknown source ID produces NEEDS_REVIEW / MAPPING_FAILED.

Azure has a 60-second timeout. A provider exception, timeout, or unusable result produces NEEDS_REVIEW / EXTRACTION_FAILED. The application shows a safe message rather than a raw provider traceback.

### Public internal interfaces

    process_invoice(
        pdf_bytes: bytes,
        filename: str,
        stage_callback: Callable[[StageEvent], None] | None = None,
    ) -> ProcessResult

Validates input, creates a run before any provider call, executes the pipeline, persists every durable result, and returns the final view model.

    resume_with_po(
        run_id: str,
        po_number: str,
        stage_callback: Callable[[StageEvent], None] | None = None,
    ) -> ProcessResult

Accepts only a PO stored in that run's candidate list, records it on the same run, reruns all PO-dependent and mutable controls, and posts only if all controls pass. Repeating confirmation after a successful post returns the existing ProcessResult and ledger ID.

    resume_with_bundle(
        run_id: str,
        candidate_id: str,
        stage_callback: Callable[[StageEvent], None] | None = None,
    ) -> ProcessResult

Accepts only an unknown-bundle decomposition stored on that run. It keeps the same run ID, reruns tax normalization, matching, duplicate, price, quantity, receipt, and value controls against current database state, and posts only when every control passes. Repeating confirmation after a successful post returns the existing ProcessResult and ledger ID.

    post_invoice(
        run_id: str,
        evaluation: Evaluation,
    ) -> str

Runs inside one SQLite write transaction. It rechecks duplicate and mutable capacity controls, inserts the ledger invoice and allocations, updates the run to POSTED, and returns the ledger invoice ID. It is idempotent by run ID.

    reset_demo() -> None

Closes active database handles, replaces the temporary runtime database with data/seed.sqlite, deletes temporary uploaded PDFs, and leaves committed files untouched.

### Core schemas

InvoiceMapping is the only model returned by OpenAI. Every scalar value is a nullable source ID:

    InvoiceMapping
      vendor_source_id: str | null
      invoice_number_source_id: str | null
      invoice_date_source_id: str | null
      po_number_source_id: str | null
      currency_source_id: str | null
      subtotal_source_id: str | null
      tax_source_id: str | null
      tax_inclusion_source_id: str | null
      tax_rate_source_id: str | null
      total_source_id: str | null
      lines: list[InvoiceLineMapping]
      excluded_source_ids: list[str]
      warnings: list[str]

    InvoiceLineMapping
      sku_source_id: str | null
      description_source_id: str | null
      quantity_source_id: str | null
      uom_source_id: str | null
      unit_price_source_id: str | null
      amount_source_id: str | null
      tax_inclusion_source_id: str | null
      tax_rate_source_id: str | null
      tax_amount_source_id: str | null

Python verifies that every non-null ID exists before dereferencing it. Model warnings and excluded IDs are audit context only; they cannot make a control pass.

NormalizedInvoice preserves observed values and adds deterministic accounting-normalized values:

    NormalizedInvoice
      vendor_name: str
      invoice_number: str
      normalized_invoice_number: str
      invoice_date: date
      po_number: str | null
      currency: str
      observed_subtotal: Decimal | null
      observed_tax: Decimal | null
      subtotal: Decimal
      tax: Decimal
      total: Decimal
      tax_treatment: TaxTreatment
      lines: list[NormalizedInvoiceLine]
      evidence: dict[str, SourceRef]

    NormalizedInvoiceLine
      index: int
      sku: str | null
      description: str
      quantity: Decimal
      uom: str
      observed_unit_price: Decimal
      observed_amount: Decimal
      tax_treatment: TaxTreatment
      tax_rate: Decimal | null
      net_unit_price: Decimal
      net_amount: Decimal
      tax_amount: Decimal
      evidence: dict[str, SourceRef]

Decision and matching results use these enums:

    RunState = PROCESSING | AWAITING_PO_CONFIRMATION | AWAITING_BUNDLE_CONFIRMATION | POSTED | NEEDS_REVIEW
    Decision = AUTO_CLEARED | NEEDS_REVIEW
    Execution = POSTED | BLOCKED | AWAITING_CONFIRMATION
    TaxTreatment = EXCLUSIVE | INCLUSIVE | MIXED
    PriceBasis = TAX_EXCLUSIVE | TAX_INCLUSIVE
    MatchType = DIRECT | BUNDLE_MASTER | BUNDLE_CONFIRMED

Supporting result models:

    CheckResult
      name: str
      passed: bool
      reason_code: str | null
      summary: str
      evidence: dict

    POCandidate
      po_number: str
      all_lines_resolvable: bool
      matched_line_count: int
      goods_subtotal_difference: Decimal
      line_evidence: list[dict]

    BundleComponent
      po_line_id: str
      sku: str
      quantity: Decimal
      uom: str
      po_unit_price: Decimal
      po_basis_amount: Decimal

    BundleCandidate
      candidate_id: str
      invoice_line_index: int
      components: list[BundleComponent]
      invoice_net_amount: Decimal
      po_basis_amount: Decimal
      difference: Decimal

    MatchAllocation
      invoice_line_index: int
      po_line_id: str
      match_type: MatchType
      bundle_definition_id: str | null
      component_quantity: Decimal
      po_basis_amount: Decimal
      actual_net_amount: Decimal
      evidence: dict

    StageEvent
      occurred_at: UTC ISO-8601 string
      stage: VALIDATING | EXTRACTING | MAPPING | NORMALIZING | MATCHING | CHECKING | POSTING | COMPLETE
      status: STARTED | SUCCEEDED | FAILED
      message: safe user-facing string

    ProcessResult
      run_id: str
      state: RunState
      decision: Decision
      execution: Execution
      primary_reason_code: str | null
      next_action: str | null
      invoice: NormalizedInvoice | null
      selected_po_number: str | null
      candidates: list[POCandidate]
      bundle_candidates: list[BundleCandidate]
      match_allocations: list[MatchAllocation]
      line_comparisons: list[dict]
      checks: list[CheckResult]
      ledger_invoice_id: str | null
      stage_events: list[StageEvent]

Decimals are serialized to JSON and SQLite as plain decimal strings, never binary floats. Dates use YYYY-MM-DD. Timestamps are UTC ISO-8601 strings. Observed values and derived values remain separately identifiable in persisted evidence.

## 3. Deterministic behavior

### PDF intake

- Reject empty input.
- Reject input larger than 10 MiB.
- Require the first five bytes to be %PDF-.
- Parse with pypdf.
- Reject malformed files, encrypted files, files with zero pages, and files with more than 10 pages.
- Do not require extractable embedded text. An image-only PDF is valid input and follows the same Azure extraction path.
- A local validation failure becomes NEEDS_REVIEW / BLOCKED / DOCUMENT_UNREADABLE.
- Compute SHA-256 for audit and troubleshooting only. Never branch on a fixture hash.
- Store a valid uploaded PDF under the temporary runtime directory using the run ID, never the submitted filename.

### Text normalization

Apply Unicode NFKC before all key normalization.

- Vendor, description, invoice number, PO number, and SKU: uppercase and retain only alphanumeric characters.
- UOM: uppercase and strip punctuation/whitespace. Map EA, EACH, PC, and PCS to EA. Preserve KIT only for a bundle invoice line. No quantity conversion is allowed, and bundle components must use EA in this version.
- Money: remove surrounding whitespace, commas, a leading USD token, and a leading dollar sign. Parse with Decimal. Parenthesized or explicitly negative money is unsupported.
- Quantity: remove surrounding whitespace and commas, then parse with Decimal. Quantity must be greater than zero.
- Dates: try, in order, YYYY-MM-DD, MM/DD/YYYY, MM-DD-YYYY, abbreviated-month D, YYYY, and full-month D, YYYY. Reject anything else.

All money calculations use Decimal, quantize to 0.01 with ROUND_HALF_UP, and compare using absolute differences.

### Currency

Only USD is accepted.

- An explicit USD source resolves to USD.
- If no explicit currency source exists, infer USD only when one or more selected money sources contain a dollar sign and no observed selected source contains another currency code or symbol.
- Otherwise return MISSING_REQUIRED_FIELD.
- Any explicit non-USD currency returns UNSUPPORTED_STRUCTURE.

### Required evidence

Require:

- approved vendor identity;
- invoice number;
- invoice date;
- USD currency;
- invoice total;
- at least one payable line;
- description or SKU, positive quantity, UOM, observed unit price, and observed line amount for every payable line.

Subtotal is optional. Tax is optional under the zero-tax rule or may be derived from explicit inclusive-tax evidence. PO number may be absent and enters the candidate-confirmation flow.

For every selected source with an Azure confidence value, confidence below 0.75 returns LOW_CONFIDENCE. OCR-line confidence is the minimum confidence of its overlapping words. Missing confidence on a table cell is allowed when uniqueness, required evidence, and reconciliation checks pass.

### Unsupported structures

Return UNSUPPORTED_STRUCTURE if selected or named Azure evidence contains:

- a non-zero freight, shipping, discount, credit, retainage, or special-charge field;
- a negative monetary value;
- a zero or negative line quantity;
- more than one PO reference;
- a non-USD currency;
- a line that requires UOM conversion;
- more than one bundled invoice line;
- an unknown bundle requiring more than four component lines, more than ten eligible PO lines, non-integer component quantities, or a component UOM other than EA;
- a compound, exempt, withholding, reverse-charge, or tax-recoverability determination;
- mixed inclusive and exclusive treatment or multiple rates whose scope cannot be tied explicitly to individual lines.

A zero-valued freight, shipping, or discount field is allowed and is ignored after being recorded in evidence.

### Tax treatment and arithmetic reconciliation

Preserve every observed unit price and line amount. For every invoice line:

    abs(quantity * observed unit price - observed line amount) <= 0.01

If this fails, return TOTAL_MISMATCH.

For tax-exclusive lines, net unit price and net amount equal their observed values. A separately observed header or line tax remains tax and is not included in the comparable PO price.

For a tax-inclusive line, require all of the following:

- selected source evidence explicitly states that the price or amount includes tax;
- an explicit percentage rate exists in the same source or another selected tax-rate source;
- the evidence applies to that line or clearly applies invoice-wide;
- the percentage is greater than zero and less than 100;
- the selected PO declares TAX_EXCLUSIVE price basis;
- inclusion and rate evidence pass the normal confidence threshold.

Python parses the percentage and calculates with Decimal and ROUND_HALF_UP:

    rate = observed percentage / 100
    unrounded net amount = observed gross amount / (1 + rate)
    net amount = quantize(unrounded net amount, 0.01)
    tax amount = observed gross amount - net amount
    net unit price = net amount / quantity

Different rates are allowed only when every rate is explicitly associated with its line. A mixture of inclusive and exclusive lines is allowed only when treatment is explicit for every affected line. Never infer inclusion or a rate from the difference between invoice and PO values.

When invoice-wide tax rounding creates a one-cent residual, adjust only one derived net line: choose the line with the largest discarded fractional remainder, break ties by invoice line index, apply at most $0.01, and persist the adjustment in evidence. No larger or unexplained adjustment is allowed.

Let normalized goods subtotal be the sum of line net amounts and normalized tax be the sum of derived line tax plus any separately observed header tax not already assigned to a line.

- If observed subtotal exists, it must equal normalized goods subtotal within 0.01 after the permitted recorded rounding adjustment.
- If observed tax exists, it must equal normalized tax within 0.01 after the permitted recorded rounding adjustment.
- Normalized goods subtotal plus normalized tax must equal invoice total within 0.01.
- If no tax evidence exists, treat tax as zero only when the observed line amounts sum to invoice total within 0.01.
- Missing, conflicting, or ambiguous inclusion, rate, scope, or PO price-basis evidence returns TAX_TREATMENT_UNRESOLVED.
- Other arithmetic failures return TOTAL_MISMATCH.

Tax is reconciled but never consumes PO quantity or value capacity. PO comparisons and allocations use normalized net amounts.

### Vendor resolution

Normalize the observed vendor name and compare it exactly with the seeded canonical vendor name and aliases.

- Exactly one active vendor match is required.
- An unknown or ambiguous vendor returns VENDOR_OR_PO_MISMATCH.
- OpenAI cannot create or approve an alias.

### Duplicate resolution

Run duplicate detection immediately after vendor and normalized invoice-number resolution, before PO eligibility or line matching.

A duplicate is an existing posted invoice with the same canonical vendor ID and normalized invoice number. Return DUPLICATE and do not create an allocation.

If the current run has already posted, return its existing ledger ID instead of treating the same run as a new duplicate.

### Explicit PO resolution

When a PO number is present:

- Normalize it and require exactly one matching purchase order.
- Require OPEN status.
- Require the resolved vendor.
- Require USD.
- Require a declared price basis. All committed seed POs use TAX_EXCLUSIVE; TAX_INCLUSIVE, unknown, or incompatible PO price basis returns TAX_TREATMENT_UNRESOLVED in this version.
- Any failure returns VENDOR_OR_PO_MISMATCH.

### Missing-PO candidate flow

When the invoice has no PO reference:

1. Query open USD POs for the resolved vendor.
2. Evaluate each PO with the same direct, trusted-bundle, and bounded unknown-bundle resolver.
3. Compute each candidate's sort key:
   - all lines resolvable through direct or trusted-bundle matching, true before false;
   - matched line count, descending;
   - absolute difference between normalized net goods subtotal and remaining PO-basis value, ascending;
   - normalized PO number, ascending.
4. Persist at most the first three candidates and their evidence.
5. Never auto-select a candidate.

If candidates exist, persist NEEDS_REVIEW / AWAITING_CONFIRMATION / MISSING_PO and set the run state to AWAITING_PO_CONFIRMATION. If none exist, persist NEEDS_REVIEW / BLOCKED / MISSING_PO and set the run state to NEEDS_REVIEW.

Confirmation accepts only a PO number stored on that run. It keeps the same run ID and reruns tax, explicit-PO eligibility, direct and bundle matching, price, duplicate, and mutable capacity checks against current database state. A confirmed PO may legitimately move the same run into AWAITING_BUNDLE_CONFIRMATION before it can post.

### Direct and bundle line matching

Process invoice lines in document order and maintain reserved_quantity_by_po_line. A PO line's available quantity is its remaining ordered and received capacity minus quantities already reserved by earlier invoice lines or bundle components in the current evaluation.

Direct matching runs first:

1. If SKU is present, find PO lines with exactly equal normalized SKU and canonical UOM and enough unreserved capacity.
2. If SKU is absent, find PO lines with exactly equal normalized description and canonical UOM and enough unreserved capacity.
3. Require exactly one match.
4. Reserve the invoice quantity on that PO line.

Description is not used as a fallback when an invoice SKU is present but does not match.

If direct matching fails, trusted bundle matching may run for at most one invoice line:

1. Resolve exactly one active bundle definition for the vendor by exact normalized bundle SKU, or by exact normalized description only when invoice SKU is absent.
2. Require the invoice bundle UOM to match the definition.
3. For each configured component, find exactly one selected-PO line with the configured SKU and EA UOM.
4. Calculate component quantity = invoice bundle quantity * configured quantity per bundle.
5. Reserve every component quantity and require ordered and received capacity component by component.
6. Require the invoice line's normalized net amount to equal the sum of component PO-basis amounts within 0.01.

A trusted definition may auto-clear only after all normal checks pass. It produces one MatchAllocation per component and never creates a synthetic PO line for the bundle.

If no trusted definition exists, Python may generate unknown-bundle decompositions from the selected PO. Candidate generation is bounded:

- same selected PO and vendor;
- at least two and at most four component lines;
- at most ten eligible PO lines;
- positive integer EA component quantities only;
- quantities no greater than unreserved ordered or received capacity;
- exact normalized net amount match within 0.01;
- no component reuse beyond available reserved quantity.

Persist at most three candidates ordered by component count, then lexicographically by PO-line IDs and quantities. Even one unique amount-based candidate never auto-posts. If candidates exist, return NEEDS_REVIEW / AWAITING_CONFIRMATION / BUNDLE_MAPPING_REQUIRED and set AWAITING_BUNDLE_CONFIRMATION. If none exist, return NEEDS_REVIEW / BLOCKED / BUNDLE_MAPPING_REQUIRED.

Bundle confirmation accepts only a stored candidate, keeps the same run ID, and reruns every tax, duplicate, matching, receipt, capacity, value, and posting check. Neither confirmation nor successful posting creates a permanent bundle definition.

A non-bundle direct line with zero matches, multiple matches, incompatible UOM, or insufficient unique assignment returns LINE_MATCH_FAILED.

### Price controls

For every direct matched line against a TAX_EXCLUSIVE PO price:

    per-line variance ratio =
      abs(invoice net unit price - PO unit price) / PO unit price

Require:

    per-line variance ratio <= 0.01

Across all lines:

    aggregate price variance =
      sum(abs(invoice net unit price - PO unit price) * invoice quantity)

Require:

    aggregate price variance <= 5.00

Equality at 1% and $5.00 passes. Any failure returns PRICE_VARIANCE_EXCEEDED. A zero PO price requires exact zero invoice net price; otherwise it fails.

Known and reviewer-confirmed bundles do not receive the 1% or $5 tolerance because component prices are not observed on the invoice. Require:

    abs(invoice bundle net amount - sum(component PO-basis amounts)) <= 0.01

Any larger bundle difference returns PRICE_VARIANCE_EXCEEDED.

### Quantity and value capacity

For each PO line:

    prior posted quantity =
      sum(all committed allocation quantities for that PO line)

    remaining ordered quantity =
      ordered quantity - prior posted quantity

    remaining received quantity =
      received quantity - prior posted quantity

Require:

    current direct or component quantity <= remaining received quantity
    current direct or component quantity <= remaining ordered quantity

A receipt failure returns RECEIPT_CAPACITY_EXCEEDED. An ordered-quantity failure returns PO_CAPACITY_EXCEEDED.

PO value is measured at PO prices:

    invoice PO-basis value =
      sum(direct or component quantity * matched PO unit price)

    PO total basis value =
      sum(ordered quantity * PO unit price)

    prior PO-basis allocation =
      sum(committed allocation PO-basis values for the PO)

Require:

    prior PO-basis allocation + invoice PO-basis value
      <= PO total basis value

A value failure returns PO_CAPACITY_EXCEEDED. Invoice tax and permitted direct-line invoice-price variance do not consume PO-basis capacity. Bundle allocations use their exact component PO-basis values.

### Check order and primary reason

Persist all checks that can be evaluated safely, but select the primary reason using this precedence:

1. DOCUMENT_UNREADABLE
2. EXTRACTION_FAILED
3. MAPPING_FAILED
4. LOW_CONFIDENCE
5. MISSING_REQUIRED_FIELD
6. TAX_TREATMENT_UNRESOLVED
7. UNSUPPORTED_STRUCTURE
8. TOTAL_MISMATCH
9. VENDOR_OR_PO_MISMATCH
10. DUPLICATE
11. MISSING_PO
12. BUNDLE_MAPPING_REQUIRED
13. LINE_MATCH_FAILED
14. PRICE_VARIANCE_EXCEEDED
15. RECEIPT_CAPACITY_EXCEEDED
16. PO_CAPACITY_EXCEEDED
17. PROCESSING_ERROR

Checks whose prerequisites are unavailable are marked skipped in evidence and cannot overwrite an earlier primary reason. Any failed blocking check prevents posting.

### Decision and execution

- All checks pass: AUTO_CLEARED / POSTED, run state POSTED.
- Missing PO with candidates: NEEDS_REVIEW / AWAITING_CONFIRMATION, run state AWAITING_PO_CONFIRMATION.
- Unknown bundle with stored decompositions: NEEDS_REVIEW / AWAITING_CONFIRMATION, run state AWAITING_BUNDLE_CONFIRMATION.
- Every other failure: NEEDS_REVIEW / BLOCKED, run state NEEDS_REVIEW.

When both references are missing, PO confirmation occurs first. The same run may then await bundle confirmation. No run exposes both confirmation controls simultaneously.

### Atomic and idempotent posting

Posting uses BEGIN IMMEDIATE and one transaction:

1. Reload the run.
2. If it already has a posted invoice, return that invoice ID.
3. Recheck vendor/invoice duplicate against committed rows.
4. Reload the selected PO, price basis, matched PO lines, stored bundle candidate or bundle-definition version, and all prior allocations.
5. Recompute tax-normalized values and recheck direct or component quantities, receipts, ordered capacity, bundle amount equality, and PO-basis capacity.
6. Insert one posted_invoices row.
7. Insert one allocations row per direct match or bundle component.
8. Set the run decision to AUTO_CLEARED, execution to POSTED, state to POSTED, and store its ledger ID.
9. Commit.

Any failure rolls the whole transaction back. Database uniqueness conflicts from another run become DUPLICATE. Repeated Streamlit clicks or confirmation calls must not create a second invoice or allocation.

## 4. Reason-code contract

Use only these stable codes:

| Reason code | Meaning | User-facing next action |
| --- | --- | --- |
| DOCUMENT_UNREADABLE | File failed local PDF validation. | Upload a valid, unencrypted PDF within the size and page limits. |
| EXTRACTION_FAILED | Azure did not return usable evidence. | Retry once; if it repeats, verify service configuration or use a clearer PDF. |
| LOW_CONFIDENCE | Selected critical evidence is below 0.75 confidence. | Verify the highlighted field in the source document; this demo does not support overrides. |
| MAPPING_FAILED | OpenAI mapping failed or referenced unknown evidence. | Inspect the extracted evidence and retry; no values were assumed. |
| MISSING_REQUIRED_FIELD | A required invoice value is absent or unparseable. | Correct the invoice or provide a document containing the highlighted field. |
| TAX_TREATMENT_UNRESOLVED | Inclusion, rate, scope, or PO price basis cannot be established deterministically. | Provide explicit tax treatment and rate evidence or route the invoice for manual tax review. |
| VENDOR_OR_PO_MISMATCH | Vendor or explicit PO is unknown, closed, wrong-vendor, or non-USD. | Verify the vendor and PO reference in the source system. |
| MISSING_PO | The invoice omitted its PO reference. | Confirm one of the stored candidates, or correct the invoice when no candidate exists. |
| BUNDLE_MAPPING_REQUIRED | A line may represent multiple PO components, but no trusted or reviewer-confirmed decomposition is available. | Confirm a stored decomposition when offered; otherwise provide trusted bundle master data or an itemized invoice. |
| LINE_MATCH_FAILED | A unique exact invoice-to-PO line assignment was not possible. | Verify SKU, description, and UOM; manual remapping is out of scope. |
| DUPLICATE | Vendor and normalized invoice number already exist in the posted ledger. | Review the existing ledger invoice; do not repost. |
| RECEIPT_CAPACITY_EXCEEDED | A direct or bundle-component quantity exceeds remaining received quantity. | Record or correct the goods receipt before retrying. |
| PO_CAPACITY_EXCEEDED | A direct or component quantity or PO-basis value exceeds remaining ordered capacity. | Amend the PO or correct the invoice before retrying. |
| PRICE_VARIANCE_EXCEEDED | A direct line exceeds 1%, aggregate direct variance exceeds $5.00, or a bundle differs from component PO basis by more than $0.01. | Review the invoice price against the PO or bundle definition. |
| TOTAL_MISMATCH | Line, subtotal, tax, or total arithmetic does not reconcile within $0.01. | Correct the invoice arithmetic. |
| UNSUPPORTED_STRUCTURE | Invoice contains an explicitly out-of-scope structure. | Route it to the normal manual AP process. |
| PROCESSING_ERROR | An unexpected internal error was safely contained. | Retry; if it repeats, inspect application diagnostics without reposting. |

Only MISSING_PO with stored PO candidates and BUNDLE_MAPPING_REQUIRED with stored decompositions expose in-app resolution controls. Other outcomes show guidance but no override.

## 5. Persistence contract

### Runtime location

data/seed.sqlite is immutable and committed. On first launch, copy it to:

    Path(tempfile.gettempdir()) / "zamp-ap-resolution-demo" / "runtime.db"

Uploaded PDFs live under the same temporary directory in uploads/<run-id>.pdf. Normal Streamlit reruns reuse the runtime database. Reset replaces it from the seed and deletes uploads.

Community Cloud local storage is treated as semi-persistent. If the temporary runtime directory disappears, the application initializes a new runtime copy from the seed. The product must label itself a single-user resettable demo, not durable storage.

### SQLite tables

vendors:

- id TEXT primary key.
- canonical_name TEXT not null unique.
- normalized_name TEXT not null unique.
- aliases_json TEXT not null.
- active INTEGER not null, constrained to 0 or 1.

purchase_orders:

- po_number TEXT primary key.
- normalized_po_number TEXT not null unique.
- vendor_id TEXT not null, foreign key to vendors.
- currency TEXT not null.
- price_basis TEXT not null, TAX_EXCLUSIVE or TAX_INCLUSIVE.
- status TEXT not null, OPEN or CLOSED.

po_lines:

- id TEXT primary key.
- po_number TEXT not null, foreign key to purchase_orders.
- line_number INTEGER not null.
- sku TEXT.
- normalized_sku TEXT.
- description TEXT not null.
- normalized_description TEXT not null.
- uom TEXT not null.
- ordered_quantity TEXT not null.
- received_quantity TEXT not null.
- unit_price TEXT not null.
- unique po_number plus line_number.

bundle_definitions:

- id TEXT primary key.
- vendor_id TEXT not null, foreign key to vendors.
- normalized_bundle_sku TEXT.
- normalized_description TEXT.
- bundle_uom TEXT not null.
- version INTEGER not null.
- components_json TEXT not null; each component contains SKU, quantity per bundle, and EA UOM.
- active INTEGER not null, constrained to 0 or 1.
- require at least one of normalized_bundle_sku or normalized_description and unique vendor plus active key/version.

runs:

- id TEXT primary key.
- created_at and updated_at TEXT not null.
- filename TEXT not null.
- file_sha256 TEXT not null.
- pdf_path TEXT.
- state TEXT not null.
- decision TEXT.
- execution TEXT.
- vendor_id TEXT.
- normalized_invoice_number TEXT.
- selected_po_number TEXT.
- primary_reason_code TEXT.
- next_action TEXT.
- ledger_invoice_id TEXT.
- extraction_json TEXT.
- mapping_json TEXT.
- evaluation_json TEXT.
- candidates_json TEXT.
- bundle_candidates_json TEXT.
- stage_events_json TEXT not null.

posted_invoices:

- id TEXT primary key.
- run_id TEXT unique and nullable for immutable seed-ledger records.
- origin TEXT not null, SEED or RUN.
- vendor_id TEXT not null.
- invoice_number TEXT not null.
- normalized_invoice_number TEXT not null.
- invoice_date TEXT not null.
- currency TEXT not null.
- subtotal TEXT not null; normalized tax-exclusive goods subtotal.
- tax TEXT not null; observed or deterministically derived tax.
- total TEXT not null; observed gross invoice total.
- po_number TEXT.
- posted_at TEXT not null.
- unique vendor_id plus normalized_invoice_number.

allocations:

- id TEXT primary key.
- posted_invoice_id TEXT not null.
- invoice_line_index INTEGER not null.
- po_line_id TEXT not null.
- match_type TEXT not null, DIRECT, BUNDLE_MASTER, or BUNDLE_CONFIRMED.
- bundle_definition_id TEXT nullable, foreign key to bundle_definitions.
- component_quantity TEXT not null.
- po_basis_amount TEXT not null.
- actual_net_amount TEXT not null.
- evidence_json TEXT not null.
- unique posted_invoice_id plus invoice_line_index plus po_line_id.

Enable SQLite foreign keys on every connection. Seed ledger rows have null run_id so the dashboard starts with no user runs while duplicate and prior-capacity controls still see the existing ledger.

## 6. Seed data and fixture contract

The fixture generator must produce the same PDF content, seed rows, and case manifest on every run. PDF metadata timestamps must be fixed or omitted so regeneration is byte-stable where ReportLab permits it.

### Vendors

ACME:

- ID: V-ACME.
- Canonical name: Acme Industrial Supplies LLC.
- Aliases: Acme Industrial; Acme Supplies.

DELTA:

- ID: V-DELTA.
- Canonical name: Delta Components Ltd.
- Aliases: Delta Components.

### Purchase orders

PO-0999:

- Vendor V-ACME, USD, TAX_EXCLUSIVE, CLOSED.
- Line 1: FIL-900, Replacement Filter, 1 EA ordered, 1 EA received, $100.00.

PO-1001:

- Vendor V-ACME, USD, TAX_EXCLUSIVE, OPEN.
- Line 1: WID-100, Industrial Widget, 10 EA ordered, 10 EA received, $100.00.
- Line 2: BOL-200, Mounting Bolt Pack, 5 EA ordered, 5 EA received, $20.00.

PO-1002:

- Vendor V-ACME, USD, TAX_EXCLUSIVE, OPEN.
- Line 1: SEN-300, Safety Sensor, 2 EA ordered, 2 EA received, $250.00.

PO-1003:

- Vendor V-ACME, USD, TAX_EXCLUSIVE, OPEN.
- Line 1: CAB-400, Cable Harness, 4 EA ordered, 4 EA received, $125.00.

PO-1004:

- Vendor V-ACME, USD, TAX_EXCLUSIVE, OPEN.
- Line 1: WID-100, Industrial Widget, 2 EA ordered, 2 EA received, $100.00.
- Line 2: BOL-200, Mounting Bolt Pack, 5 EA ordered, 5 EA received, $20.00.
- Reserved for the trusted-bundle acceptance fixture.

PO-1005:

- Vendor V-ACME, USD, TAX_EXCLUSIVE, OPEN.
- Line 1: WID-100, Industrial Widget, 2 EA ordered, 2 EA received, $100.00.
- Line 2: BOL-200, Mounting Bolt Pack, 5 EA ordered, 5 EA received, $20.00.
- Reserved for the unknown-bundle confirmation fixture.

PO-2001:

- Vendor V-DELTA, USD, TAX_EXCLUSIVE, OPEN.
- Line 1: VAL-500, Control Valve, 10 EA ordered, 6 EA received, $50.00.

### Bundle definitions

BUNDLE-ACME-KIT-300 version 1:

- Vendor V-ACME, active.
- Exact invoice SKU KIT-300; exact fallback description Installation Kit when SKU is absent.
- Invoice UOM KIT.
- Per 1 KIT: WID-100, 2 EA.
- Per 1 KIT: BOL-200, 5 EA.
- The definition is trusted seed master data and is never created or changed by OpenAI or reviewer confirmation.

### Existing ledger baseline

LEDGER-SEED-001:

- Vendor V-ACME.
- Invoice ACME-2026-000.
- PO-0999.
- Invoice date 2026-06-01.
- Subtotal $100.00, tax $10.00, total $110.00.
- Direct allocation: invoice line 0 to PO-0999 line 1, component quantity 1, PO-basis $100.00, actual net amount $100.00.

LEDGER-SEED-002:

- Vendor V-DELTA.
- Invoice DELTA-2026-009.
- PO-2001.
- Invoice date 2026-06-15.
- Subtotal $200.00, tax $20.00, total $220.00.
- Direct allocation: invoice line 0 to PO-2001 line 1, component quantity 4, PO-basis $200.00, actual net amount $200.00.

### Fixture 1: happy.pdf

- Vendor: Acme Industrial Supplies LLC.
- Invoice number: ACME-2026-001.
- Invoice date: 2026-07-01.
- PO: PO-1001.
- Currency: USD.
- Line 1: WID-100, Industrial Widget, 8 EA at $100.00, amount $800.00.
- Line 2: BOL-200, Mounting Bolt Pack, 5 EA at $20.00, amount $100.00.
- Subtotal: $900.00.
- Tax: $90.00.
- Total: $990.00.

Expected result after reset:

- AUTO_CLEARED / POSTED.
- No reason code.
- Exactly one new ledger invoice.
- Exactly two new allocations.
- PO-1001 remaining widget ordered/received quantity: 2.
- PO-1001 remaining bolt-pack ordered/received quantity: 0.

### Fixture 2: duplicate.pdf

- Vendor: Acme Industrial Supplies LLC.
- Invoice number: ACME-2026-000.
- Invoice date: 2026-06-01.
- PO: PO-0999.
- Currency: USD.
- Line 1: FIL-900, Replacement Filter, 1 EA at $100.00, amount $100.00.
- Subtotal: $100.00.
- Tax: $10.00.
- Total: $110.00.

Expected result:

- NEEDS_REVIEW / BLOCKED.
- Primary reason DUPLICATE, selected before the PO-0999 closed-status failure.
- Zero new ledger invoices.
- Zero new allocations.

### Fixture 3: missing_po.pdf

- Vendor: Acme Industrial Supplies LLC.
- Invoice number: ACME-2026-002.
- Invoice date: 2026-07-02.
- No PO reference.
- Currency: USD.
- Line 1: SEN-300, Safety Sensor, 2 EA at $251.00, amount $502.00.
- Subtotal: $502.00.
- Tax: $50.20.
- Total: $552.20.

Expected before confirmation:

- NEEDS_REVIEW / AWAITING_CONFIRMATION.
- Run state AWAITING_PO_CONFIRMATION.
- Primary reason MISSING_PO.
- PO-1002 ranked first.
- No ledger or allocation mutation.

Expected after confirming stored candidate PO-1002:

- Same run ID.
- AUTO_CLEARED / POSTED.
- Per-line variance 0.4%.
- Aggregate price variance $2.00.
- Exactly one new ledger invoice and one allocation.
- Repeated confirmation returns the existing ledger ID.

### Fixture 4: receipt_capacity.pdf

- Vendor: Delta Components Ltd.
- Invoice number: DELTA-2026-010.
- Invoice date: 2026-07-03.
- PO: PO-2001.
- Currency: USD.
- Line 1: VAL-500, Control Valve, 3 EA at $50.00, amount $150.00.
- Subtotal: $150.00.
- Tax: $15.00.
- Total: $165.00.

PO-2001 has 10 ordered and 6 received, with 4 already allocated. Remaining ordered quantity is 6 and remaining received quantity is 2.

Expected result:

- NEEDS_REVIEW / BLOCKED.
- Primary reason RECEIPT_CAPACITY_EXCEEDED.
- Ordered and PO-basis capacity checks pass.
- Zero new ledger invoices.
- Zero new allocations.

### Fixture 5: happy_layout_b.pdf

This machine-readable PDF contains exactly the same business values as happy.pdf but uses a materially different layout:

- Bill No. instead of Invoice Number.
- Your Reference instead of Purchase Order.
- Quantities rendered as 8 pcs and 5 pcs.
- Totals shown in a right-hand sidebar.
- Line descriptions wrap independently from SKU cells.

Expected result after reset is identical to happy.pdf, including normalized fields, two direct allocations, ledger delta, and remaining capacities.

### Fixture 6: happy_layout_c_scanned.pdf

This high-quality image-only PDF also contains exactly the same business values as happy.pdf:

- Document ID instead of Invoice Number.
- Order Ref instead of Purchase Order.
- Net, Tax, and Gross labels.
- Multiline descriptions and a visually different table.
- pypdf extracts no meaningful invoice text; Azure OCR supplies the evidence.

Expected result after reset is identical to happy.pdf. The recorded Azure result must preserve usable OCR words, lines, confidence, source locations, fields or tables, and line items. A low-confidence scan is tested through a deterministic recorded payload rather than a live confidence expectation.

### Fixture 7: bundle_known.pdf

- Vendor: Acme Industrial Supplies LLC.
- Invoice number: ACME-2026-003.
- Invoice date: 2026-07-04.
- PO: PO-1004.
- Currency: USD.
- Line 1: KIT-300, Installation Kit, 1 KIT at $300.00, observed/net amount $300.00.
- No tax; total $300.00.

BUNDLE-ACME-KIT-300 expands the line into 2 EA WID-100 and 5 EA BOL-200.

Expected result after reset:

- AUTO_CLEARED / POSTED with no reviewer action.
- One ledger invoice and two BUNDLE_MASTER allocations.
- WID-100 allocation: quantity 2, PO-basis and actual net amount $200.00.
- BOL-200 allocation: quantity 5, PO-basis and actual net amount $100.00.
- PO-1004 remaining widget and bolt-pack ordered/received quantities: 0.

### Fixture 8: bundle_unknown.pdf

- Vendor: Acme Industrial Supplies LLC.
- Invoice number: ACME-2026-004.
- Invoice date: 2026-07-05.
- PO: PO-1005.
- Currency: USD.
- Line 1: no SKU, Maintenance Pack, 1 KIT at $300.00, observed/net amount $300.00.
- No tax; total $300.00.
- No trusted bundle definition matches the SKU or description.

Candidate generation excludes single-line decompositions and produces one stored two-component proposal: 2 EA WID-100 plus 5 EA BOL-200.

Expected before confirmation:

- NEEDS_REVIEW / AWAITING_CONFIRMATION.
- Run state AWAITING_BUNDLE_CONFIRMATION.
- Primary reason BUNDLE_MAPPING_REQUIRED.
- No ledger or allocation mutation.

Expected after confirming the stored decomposition:

- Same run ID.
- AUTO_CLEARED / POSTED.
- One ledger invoice and two BUNDLE_CONFIRMED allocations with the same $200.00 and $100.00 component values as the known bundle.
- Repeated confirmation returns the existing ledger ID.
- No permanent bundle definition is created.

### Fixture 9: tax_inclusive.pdf

- Vendor: Acme Industrial Supplies LLC.
- Invoice number: ACME-2026-005.
- Invoice date: 2026-07-06.
- PO: PO-1002, whose price basis is TAX_EXCLUSIVE.
- Currency: USD.
- Line 1: SEN-300, Safety Sensor, 2 EA at observed gross unit price $295.00, observed gross amount $590.00.
- Explicit source note: All line prices include 18% tax.
- No observed subtotal or separate tax amount.
- Gross invoice total: $590.00.

Expected normalized values:

- Net unit price $250.00.
- Net line amount and subtotal $500.00.
- Derived tax $90.00.
- Gross total $590.00.

Expected result after reset:

- AUTO_CLEARED / POSTED with no reason code.
- One direct allocation, component quantity 2, PO-basis and actual net amount $500.00.
- PO-1002 remaining ordered/received quantity: 0.
- Observed inclusion/rate sources and every derivation are visible in evidence.

## 7. Phase-wise implementation

### Phase 0 — Canonical contract, environment, and deterministic fixtures (complete)

Goal: establish one reproducible contract before application development.

Status: complete and validated on 2026-07-10 for the original four-fixture baseline. Those artifacts regenerate byte-for-byte, SQLite integrity and foreign-key checks pass, and the recorded prebuilt-invoice result contains usable fields, items, tables, confidence, and source locations. The expanded contract below requires Phase 0B before Phase 1.

Deliverables:

- Replace the corrupted/repeated planning material with this canonical BUILD_SPEC.md.
- Pin Python 3.12 dependencies in requirements.txt.
- Add .env.example and ignore .env, runtime databases, temporary uploads, and provider secrets.
- Add the deterministic fixture generator.
- Generate the four PDFs exactly as specified.
- Generate the original four-fixture data/seed.sqlite baseline, which Phase 0B subsequently extends to the canonical schema and rows above.
- Generate the original data/cases.json expectations, which Phase 0B subsequently extends for the new capabilities.
- Add scripts/verify_azure.py to submit local PDF bytes to prebuilt-invoice rather than a hard-coded public URL.
- Verify the happy fixture produces usable fields, line items/tables, confidence, and source locations.
- Save the happy-fixture Azure response to data/recordings/happy_azure.json for offline test adapters. The recording is test-only and must never be selected in the live UI by file hash.

Exit gate:

- All four PDFs exist and open successfully.
- The seed database matches the exact baseline.
- Every case has one unambiguous expected outcome.
- The happy PDF succeeds through live Azure extraction from local uploaded bytes.
- Regenerating fixtures does not introduce semantic or seed-data drift.

### Phase 0B — Expanded scan, layout, bundle, and tax baseline (complete)

Goal: extend the completed deterministic baseline before application development begins.

Status: complete and validated on 2026-07-11. All nine fixtures regenerate byte-for-byte, the expanded seed passes SQLite integrity and foreign-key checks, the scanned fixture contains no embedded invoice text, and live Azure recordings exist for the scanned, known-bundle, unknown-bundle, and inclusive-tax cases.

Deliverables:

- Extend the seed schema with PO price basis, bundle definitions, bundle-confirmation state, and auditable component allocations.
- Seed PO-1004 and PO-1005 for isolated bundle runs, seed BUNDLE-ACME-KIT-300 version 1, and mark every committed PO TAX_EXCLUSIVE.
- Preserve the original four fixtures and add happy_layout_b.pdf, happy_layout_c_scanned.pdf, bundle_known.pdf, bundle_unknown.pdf, and tax_inclusive.pdf.
- Extend data/cases.json with normalized gross/net/tax expectations, bundle candidates, confirmation outcomes, match types, component allocations, and layout-equivalence assertions.
- Extend source-reference generation for nested tax fields, OCR lines with word-derived confidence, and optional key-value pairs returned by the same Azure call.
- Record live Azure responses for the scanned layout, known bundle, unknown bundle, and inclusive-tax fixtures for offline tests.
- Confirm that no filename or file hash selects a mapping, bundle definition, tax treatment, or decision.

Exit gate:

- All nine PDFs exist, open successfully, and regenerate without semantic or seed-data drift.
- happy.pdf, happy_layout_b.pdf, and happy_layout_c_scanned.pdf normalize to equivalent business values and decisions.
- The scanned fixture has no meaningful embedded text but succeeds through Azure OCR from local bytes.
- The trusted bundle definition expands to the exact two seeded component allocations.
- The unknown bundle stores a bounded decomposition and changes no accounting state before confirmation.
- The inclusive-tax fixture yields $500.00 net, $90.00 tax, and $590.00 gross from explicit source evidence.
- The seed database passes integrity and foreign-key checks with the expanded exact baseline.

### Phase 1 — Complete happy-path vertical slice

Goal: make the core product runnable before adding exceptions.

Deliverables:

- Initialize the temporary runtime database from the immutable seed only when absent.
- Build the Process Invoice tab with uploader, fixture selector, Run button, and real status updates.
- Implement PDF validation and safe temporary storage.
- Implement Azure extraction and field, item, tax, table, OCR-line, and optional key-value SourceRef catalogue creation.
- Implement the expanded InvoiceMapping and one structured OpenAI mapping call.
- Validate source IDs, dereference evidence, and normalize in Python.
- Implement exact vendor, explicit PO, direct-line, UOM, separate-tax arithmetic, and minimum capacity checks.
- Implement atomic posting and before/after capacity evidence.
- Persist extraction, mapping, checks, stage events, decision, and ledger ID.

Exit gate:

- Reset, upload happy.pdf, observe real stages, receive AUTO_CLEARED, and see exactly one ledger post.
- Repeated UI action for the same run cannot create another post.

### Phase 2 — Complete controls and idempotent state

Goal: make the decision engine trustworthy.

Deliverables:

- Implement every normalization, confidence, required-field, tax-treatment, unsupported-structure, arithmetic, price, duplicate, receipt, ordered-quantity, and PO-basis rule in this specification.
- Implement trusted bundle lookup, deterministic component expansion, reserved quantities, and exact bundle pricing.
- Preserve observed gross values alongside normalized net and tax values.
- Add database constraints and transaction rollback behavior.
- Implement every stable reason code and next action.
- Return invoice-versus-PO line comparisons and check evidence.
- Implement explicit reset and verify exact restoration.

Exit gate:

- Pure engine tests cover all control boundaries.
- Double processing and double posting remain idempotent.
- Every blocked outcome produces zero accounting mutations.
- A failed write leaves the database at its pre-transaction state.
- tax_inclusive.pdf posts using $500.00 net rather than the observed $590.00 gross for PO comparison and allocation.
- bundle_known.pdf posts exactly two BUNDLE_MASTER component allocations.

### Phase 3 — Missing-PO and unknown-bundle resolution

Goal: demonstrate controlled exception handling.

Deliverables:

- Implement deterministic PO-candidate and bounded bundle-decomposition discovery, scoring, ordering, and persistence.
- Expose PO confirmation only for stored candidates on AWAITING_PO_CONFIRMATION runs.
- Expose bundle confirmation only for stored decompositions on AWAITING_BUNDLE_CONFIRMATION runs.
- Allow PO confirmation to move the same run into bundle confirmation, but never expose both controls simultaneously.
- Resume the same run and rerun all required tax, matching, duplicate, price, receipt, capacity, value, and posting checks against current state.
- Complete exact-duplicate and receipt-capacity fixture behavior.
- Expose invoice evidence, candidate evidence, comparison data, and final checks.

Exit gate:

- A missing PO never auto-posts.
- Confirming PO-1002 resumes the same run and posts once.
- An unknown bundle never auto-posts; confirming its stored decomposition resumes the same run and posts the component allocations once.
- Duplicate and receipt-capacity fixtures remain blocked with no mutation.
- Repeated PO or bundle confirmation returns the prior posted result.

### Phase 4 — Dashboard, evidence UX, and reliability

Goal: make every result legible to a non-technical AP buyer.

Process Invoice tab:

- Uploader and fixture selector.
- Real stage status.
- Original PDF preview.
- Extracted observed values, normalized net/tax values, source location, and confidence.
- Direct and bundle invoice/PO line comparison with component allocations.
- Check results.
- Decision, execution, reason, next action, ledger ID, and capacity delta.

Dashboard & Review tab:

- Total user runs, posted count, review count, and demo auto-clear rate.
- Chronological run history with status filter.
- Run detail with persisted stage timeline and evidence.
- Candidate PO and unknown-bundle confirmation for their mutually exclusive resolvable states.

Reliability:

- Apply provider timeouts and the one OpenAI retry.
- Verify equivalent normalization across the three committed layouts and live OCR on the image-only scan.
- Convert provider and internal failures to safe blocked outcomes.
- Display a privacy notice that PDFs go to Azure and extracted text goes to OpenAI.
- Keep secrets, document text, and raw tracebacks out of logs and UI errors.
- Provide clear empty, loading, success, blocked, and configuration-error states.

Exit gate:

- A reviewer can understand each fixture without inspecting JSON.
- All nine acceptance and regression fixtures pass after reset.
- No secret, traceback, or raw provider error is exposed.

### Phase 5 — Deployment and submission

Goal: deliver a reproducible public evaluation artifact.

Deliverables:

- Deploy to Streamlit Community Cloud with Python 3.12.
- Configure provider values using Streamlit secrets.
- Verify cold-start initialization and explicit reset.
- Run live smoke tests for direct happy posting, scanned-layout posting, inclusive-tax posting, trusted-bundle posting, unknown-bundle confirmation, missing-PO confirmation, duplicate blocking, receipt blocking, history, and run inspection.
- Document local setup, tests, deployment, assumptions, privacy boundary, and limitations in README.md.
- Rehearse and record the five-minute demonstration below.

Exit gate:

- The public link works in a private browser.
- Reset restores a reproducible demo.
- The video is under five minutes.
- The video shows one live happy path and one live exception resolution.
- Duplicate and capacity fixtures are ready for interview inspection.

## 8. Verification plan

Use standard commands:

    python -m unittest
    streamlit run app.py

Default tests use recorded provider payloads and temporary databases. Live provider smoke tests are opt-in and never part of the deterministic default suite.

### Unit tests

- Empty, oversized, non-PDF, encrypted, malformed, zero-page, and over-ten-page input.
- Image-only scanned PDF acceptance without relying on pypdf text extraction.
- Field, item, nested-tax, table-cell, OCR-line, and optional key-value SourceRef ID construction and location preservation.
- OCR-line confidence derived from overlapping word confidence.
- Unknown, null, repeated, and malformed OpenAI source references.
- Provider refusal, timeout, retry, and safe error conversion.
- Vendor, invoice-number, PO, SKU, description, UOM, money, quantity, currency, and date normalization.
- Confidence exactly 0.75 passes; just below fails.
- Required-field detection.
- Unsupported charges and structures.
- Line extension difference exactly $0.01 passes; above fails.
- Separate-tax subtotal reconciliation.
- Explicit inclusive-tax parsing, gross-to-net Decimal derivation, and observed-versus-derived evidence preservation.
- Missing inclusion, rate, scope, or PO price basis returns TAX_TREATMENT_UNRESOLVED without back-solving from PO price.
- Explicit line-specific rates pass; unassociated mixed rates and compound/exempt treatment block.
- Deterministic one-cent inclusive-tax rounding adjustment and rejection above one cent.
- Exact vendor/alias and explicit-PO eligibility.
- TAX_EXCLUSIVE PO basis required for committed inclusive-tax auto-clear.
- Duplicate precedence before explicit closed-PO failure.
- Direct line assignment with reserved quantities and no over-reservation.
- Description matching only when invoice SKU is absent.
- Trusted bundle lookup by exact vendor plus SKU or description fallback, component multiplication, and component capacity checks.
- Known bundle exact net-to-PO-basis comparison and two component allocations.
- Unknown bundle bounds: two-to-four components, ten eligible lines, integer EA quantities, and exact $0.01 amount match.
- Unknown bundle candidates never auto-post and never create permanent bundle definitions.
- Bundle confirmation accepts only a stored candidate and reruns mutable controls.
- Multiple bundle lines, component UOM conversion, oversized search spaces, and overlapping unsupported allocations block safely.
- Per-line price variance exactly 1% passes; just above fails.
- Aggregate variance exactly $5.00 passes; just above fails.
- Bundle difference exactly $0.01 passes; above fails without applying direct-line tolerance.
- Receipt, ordered, and PO-basis remaining capacity.
- Tax and allowed price variance excluded from PO-basis allocation.
- PO and bundle candidate ordering and three-candidate limits.
- PO and bundle confirmation accept only candidates stored on the same run.
- Sequential PO-then-bundle confirmation keeps one run and exposes one control at a time.
- Same-run resume, double post, double PO confirmation, and double bundle confirmation idempotency.
- Transaction rollback and uniqueness-conflict conversion.
- Reset restores the seed exactly.
- Layout A, B, and scanned C provider recordings normalize to equivalent business values and decisions.

### Fixture acceptance tests

Run each fixture scenario from an independent fresh reset or temporary database unless the scenario explicitly tests a same-run confirmation. The three happy-layout variants deliberately reuse one invoice identity so their outputs can be compared without changing business data.

- happy.pdf posts one invoice and two allocations with exact remaining quantities.
- duplicate.pdf returns DUPLICATE and changes no ledger row.
- missing_po.pdf returns PO-1002 first, changes nothing before confirmation, then posts once after confirmation with the same run ID.
- receipt_capacity.pdf returns RECEIPT_CAPACITY_EXCEEDED and changes nothing.
- happy_layout_b.pdf produces the same normalized invoice, decision, allocations, and capacities as happy.pdf.
- happy_layout_c_scanned.pdf produces the same result through OCR despite having no meaningful embedded text.
- bundle_known.pdf expands trusted master data and posts two exact BUNDLE_MASTER allocations.
- bundle_unknown.pdf stores a proposal with no mutation, then posts two BUNDLE_CONFIRMED allocations after confirmation on the same run.
- tax_inclusive.pdf derives $500.00 net and $90.00 tax from $590.00 gross, compares net price to PO, and posts once.

Every acceptance assertion must compare observed and normalized monetary values, decision, execution, reason code, expected PO or bundle candidate, match types, ledger delta, allocation delta, and applicable remaining quantities against data/cases.json. Run state must also follow the decision/execution contract in Section 3.

### Manual live checks

- Uploaded bytes, not a URL, reach Azure prebuilt-invoice.
- Digital and image-only scanned PDFs use the same Azure call.
- Extracted compact evidence, not the PDF, reaches OpenAI.
- Tax statements outside standard fields are available through OCR-line or optional key-value SourceRefs.
- Layout A, B, and scanned C normalize to equivalent business values.
- Stage status reflects actual operations.
- PDF preview and evidence render in the deployed app.
- Browser refresh and widget reruns preserve runtime history.
- A provider outage cannot post an invoice.
- No file hash or fixture filename controls a decision.

## 9. Five-minute demo sequence

Before recording, reset the demo and pre-run tax_inclusive.pdf, bundle_known.pdf, duplicate.pdf, and receipt_capacity.pdf so their histories are available for inspection.

Recording:

- 0:00-0:25 — State the AP problem, two possible outcomes, deterministic control boundary, and narrow scope.
- 0:25-1:25 — Run happy_layout_c_scanned.pdf live. Show OCR stages, source evidence, direct invoice/PO comparison, checks, ledger ID, and remaining capacity.
- 1:25-3:10 — Run bundle_unknown.pdf. Show the stored component proposal, confirm it, show complete revalidation, and show the same run posting two component allocations once.
- 3:10-4:25 — Open Dashboard & Review. Inspect the prepared inclusive-tax and trusted-bundle runs, then show that duplicate and receipt-capacity runs changed no accounting state.
- 4:25-5:00 — Close with the Azure/OpenAI/Python responsibility split, explicit evidence gates, idempotency, resettable-demo limitation, and non-goals.

The video must prioritize visible judgment and evidence over feature count. Scanned input, varied layouts, trusted bundle expansion, unknown-bundle confirmation, and explicit inclusive tax are committed capabilities. The complex progress-billing sample remains stretch work and is not demonstrated.
