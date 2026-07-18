export type RunState = "PROCESSING" | "POSTED" | "AWAITING_PO_CONFIRMATION" | "AWAITING_BUNDLE_CONFIRMATION" | "NEEDS_REVIEW";

export type Execution = "POSTED" | "BLOCKED" | "AWAITING_CONFIRMATION" | "PENDING";

export type ReasonCode =
  | "APPROVED_DIRECT"
  | "APPROVED_BUNDLE"
  | "APPROVED_REVIEWER_BUNDLE"
  | "APPROVED_TAX_INCLUSIVE"
  | "DUPLICATE_INVOICE"
  | "AMBIGUOUS_DATE"
  | "MISSING_FIELD"
  | "MISSING_PO"
  | "RECEIPT_CAPACITY_EXCEEDED"
  | "PRICE_VARIANCE_EXCEEDED"
  | "UNKNOWN_BUNDLE"
  | "MULTIPLE_ISSUES"
  | "TOTAL_MISMATCH"
  | "LOW_CONFIDENCE"
  | "EXTRACTION_FAILED"
  | "MAPPING_FAILED";

export interface InvoiceLine {
  sku: string;
  description: string;
  quantity: number;
  uom: string;
  unitPrice: number;
  amount: number;
  observedUnitPrice?: number;
  observedAmount?: number;
}

export interface Invoice {
  vendor: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  poNumber: string | null;
  currency: string;
  observedSubtotal: number;
  observedTax: number;
  observedTotal: number;
  normalizedSubtotal: number;
  normalizedTax: number;
  normalizedTotal: number;
  taxTreatment: "EXCLUSIVE" | "INCLUSIVE";
  taxNote?: string;
  lines: InvoiceLine[];
  missingFields?: string[];
}

export interface DuplicateEvidence {
  ledgerId: string;
  originalInvoiceNumber: string;
  vendor: string;
  invoiceDate: string;
  poNumber: string;
  total: number;
  postedAt: string;
  originalLines: Array<{
    sku: string;
    description: string;
    quantity: number;
    uom: string;
    poBasisUnitPrice: number;
  }>;
}

export type MatchMethod = "DIRECT_PO_LINE" | "TRUSTED_BUNDLE" | "REVIEWER_CONFIRMED_BUNDLE";

export interface PoLineAllocation {
  invoiceSku: string;
  invoiceDescription: string;
  requestedQuantity: number;
  uom: string;
  poNumber: string;
  poLineId: string;
  poSku: string;
  poDescription: string;
  poUnitPrice: number;
  poBasis: number;
  orderedQuantity?: number;
  receivedQuantity?: number;
  previouslyInvoicedQuantity?: number;
  orderedBefore: number;
  orderedAfter: number;
  receivedBefore: number;
  receivedAfter: number;
  bundleDefinitionId?: string | null;
}

export interface Allocation {
  method: MatchMethod;
  explanation: string;
  lines: PoLineAllocation[];
}

export interface PoCandidateLine {
  invoiceSku: string;
  invoiceDescription: string;
  requestedQuantity: number;
  uom: string;
  invoiceUnitPrice: number;
  invoiceAmount: number;
  poLineId: string;
  poSku: string;
  poDescription: string;
  poUnitPrice: number;
  orderedAvailable: number;
  receivedAvailable: number;
  orderedQuantity?: number;
  receivedQuantity?: number;
  previouslyInvoicedQuantity?: number;
  remainingPoValue: number;
  priceVariancePct: number;
  amountDifference: number;
}

export interface PoCandidate {
  poNumber: string;
  vendor: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  aggregateDifference: number;
  lines: PoCandidateLine[];
}

export interface BundleComponent {
  poLineId: string;
  sku: string;
  description: string;
  uom: string;
  quantity: number;
  unitPrice: number;
  poBasis: number;
  orderedAvailable: number;
  receivedAvailable: number;
}

export interface BundleCandidate {
  candidateId: string;
  invoiceItemDescription: string;
  invoiceItemSku?: string;
  invoiceQuantity: number;
  poNumber: string;
  totalPoBasis: number;
  components: BundleComponent[];
  known?: boolean;
  definitionId?: string;
  definitionVersion?: number;
}

export interface CapacityIssue {
  poNumber: string;
  sku: string;
  description: string;
  uom: string;
  requested: number;
  receivedAvailable: number;
  orderedAvailable: number;
  shortfall: number;
}

export type Stage = "READING" | "MATCHING" | "FINALIZING";

export interface StageState {
  stage: Stage;
  label: string;
  status: "PENDING" | "IN_PROGRESS" | "DONE" | "FAILED";
  detail?: string;
}

export type ControlCategory = "IDENTITY" | "DUPLICATE" | "LINE_MATCH" | "PRICE" | "CAPACITY" | "ARITHMETIC" | "TAX";

export interface ControlResult {
  code: string;
  name: string;
  category: ControlCategory;
  pass: boolean;
  skipped?: boolean;
  explanation: string;
  expected?: string;
  observed?: string;
  evidenceRef?: string;
  sourceRefs?: string[];
  calculation?:
    | {
        kind: "PRICE_VARIANCE";
        sku: string;
        uom: string;
        quantity: number;
        invoiceUnitPrice: number;
        poUnitPrice: number;
        varianceAmount: number;
        variancePercent: string;
        tolerancePercent: string;
      }
    | {
        kind: "RECEIPT_CAPACITY";
        sku: string;
        uom: string;
        requestedQuantity: number;
        receivedAvailability: number;
        orderedAvailability: number;
        shortfall: number;
      };
}

export interface SourceEvidence {
  id: string;
  content: string;
  confidence: number | null;
  page: number | null;
  label: string;
}

export interface AiRecheck {
  field: string;
  originalOcrValue: string;
  ocrConfidence: number | null;
  sourceId: string;
  page: number | null;
  aiValue: string | null;
  model: string | null;
  attemptedAt: string;
  outcome: "resolved" | "needs_review";
}

export interface ActivityEntry {
  at: string;
  message: string;
  kind?: "info" | "warn" | "error" | "success";
}

export interface Run {
  runId: string;
  filename: string;
  state: RunState;
  execution: Execution;
  reasonCode: ReasonCode | null;
  nextAction: string | null;
  ledgerId: string | null;
  createdAt: string;
  updatedAt: string;
  stages: StageState[];
  invoice: Invoice | null;
  duplicateMatch?: DuplicateEvidence;
  poCandidates?: PoCandidate[];
  bundleCandidates?: BundleCandidate[];
  allocation?: Allocation;
  capacityIssues?: CapacityIssue[];
  checks: ControlResult[];
  evidence?: SourceEvidence[];
  aiRechecks?: AiRecheck[];
  activity: ActivityEntry[];
  extractionError?: string;
  mappingError?: string;
  issueCount?: number;
}
