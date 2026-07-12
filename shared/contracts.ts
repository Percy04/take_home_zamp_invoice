import { z } from "zod";

export const runStateSchema = z.enum([
  "PROCESSING",
  "POSTED",
  "AWAITING_PO_CONFIRMATION",
  "AWAITING_BUNDLE_CONFIRMATION",
  "NEEDS_REVIEW",
]);

export const sourceRefSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
  page: z.number().int().positive().nullable(),
  label: z.string().min(1),
  sourceKind: z
    .enum([
      "FIELD",
      "ITEM",
      "TAX",
      "TABLE",
      "OCR_LINE",
      "KEY_VALUE",
      "RECORDED",
    ])
    .optional(),
  tableIndex: z.number().int().nonnegative().nullable().optional(),
  row: z.number().int().nonnegative().nullable().optional(),
  column: z.number().int().nonnegative().nullable().optional(),
  lineIndex: z.number().int().nonnegative().nullable().optional(),
});

export const stageEventSchema = z.object({
  stage: z.string().min(1),
  status: z.enum(["ACTIVE", "COMPLETED", "FAILED"]),
  at: z.iso.datetime(),
});

export const checkResultSchema = z.object({
  code: z.string().min(1),
  passed: z.boolean(),
  detail: z.string().min(1),
  category: z
    .enum([
      "IDENTITY",
      "DUPLICATE",
      "PURCHASE_ORDER",
      "MATCHING",
      "AMOUNTS",
      "CAPACITY",
    ])
    .optional(),
  expected: z.string().nullable().optional(),
  actual: z.string().nullable().optional(),
  sourceIds: z.array(z.string().min(1)).optional(),
});

export const derivationSchema = z.object({
  field: z.string().min(1),
  formula: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).default([]),
});

export const invoiceLineSchema = z.object({
  sku: z.string(),
  description: z.string(),
  quantity: z.string(),
  uom: z.string(),
  observedUnitPrice: z.string(),
  observedAmount: z.string(),
  observedTaxAmount: z.string().nullable().default(null),
  unitPrice: z.string(),
  amount: z.string(),
  taxAmount: z.string().default("0.00"),
  taxTreatment: z.enum(["EXCLUSIVE", "INCLUSIVE", "ZERO"]).default("ZERO"),
  taxRate: z.string().nullable().default(null),
  sourceIds: z.record(z.string(), z.string()).default({}),
  derivations: z.array(derivationSchema).default([]),
});

export const normalizedInvoiceSchema = z.object({
  vendor: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.iso.date(),
  poNumber: z.string(),
  currency: z.literal("USD"),
  observedSubtotal: z.string().nullable(),
  observedTax: z.string().nullable(),
  observedTotal: z.string(),
  taxTreatment: z.enum(["EXCLUSIVE", "INCLUSIVE", "MIXED", "ZERO"]),
  taxRate: z.string().nullable(),
  subtotal: z.string(),
  tax: z.string(),
  total: z.string(),
  lines: z.array(invoiceLineSchema).min(1),
  fieldSources: z.record(z.string(), z.string()).default({}),
  derivations: z.array(derivationSchema).default([]),
});

export const allocationSchema = z.object({
  invoiceLineIndex: z.number().int().nonnegative(),
  poLineId: z.string(),
  poNumber: z.string(),
  sku: z.string(),
  quantity: z.string(),
  matchType: z.enum(["DIRECT", "BUNDLE_MASTER", "BUNDLE_CONFIRMED"]),
  bundleDefinitionId: z.string().nullable(),
  poBasisAmount: z.string(),
  actualNetAmount: z.string(),
  remainingOrderedQuantity: z.string(),
  remainingReceivedQuantity: z.string(),
  matchReason: z.string().optional(),
  priceVariance: z.string().nullable().optional(),
  sourceIds: z.array(z.string().min(1)).optional(),
});

export const bundleCandidateSchema = z.object({
  id: z.string(),
  invoiceLineIndex: z.number().int().nonnegative(),
  bundleQuantity: z.string(),
  totalPoBasisAmount: z.string(),
  components: z.array(
    z.object({
      poLineId: z.string(),
      sku: z.string(),
      uom: z.string(),
      quantity: z.string(),
      poBasisAmount: z.string(),
    }),
  ),
});

export const poCandidateSchema = z.object({
  poNumber: z.string().min(1),
  allLinesResolvable: z.boolean(),
  matchedLineCount: z.number().int().nonnegative(),
  remainingPoBasisValue: z.string(),
  subtotalDifference: z.string(),
});

export const runDetailSchema = z
  .object({
    runId: z.uuid(),
    filename: z.string(),
    state: runStateSchema,
    decision: z.enum(["AUTO_CLEARED", "NEEDS_REVIEW"]).nullable(),
    execution: z
      .enum(["POSTED", "BLOCKED", "AWAITING_CONFIRMATION"])
      .nullable(),
    reasonCode: z.string().nullable(),
    nextAction: z.string().nullable(),
    ledgerId: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    stages: z.array(stageEventSchema),
    evidence: z.array(sourceRefSchema),
    invoice: normalizedInvoiceSchema.nullable(),
    checks: z.array(checkResultSchema),
    allocations: z.array(allocationSchema),
    candidatePo: z.string().nullable(),
    poCandidates: z.array(poCandidateSchema),
    bundleCandidates: z.array(bundleCandidateSchema),
  })
  .superRefine((run, context) => {
    if (run.state === "POSTED" && (!run.ledgerId || run.execution !== "POSTED"))
      context.addIssue({
        code: "custom",
        message: "Posted runs require a posted execution and ledger ID.",
      });
    if (
      run.state === "AWAITING_PO_CONFIRMATION" &&
      (!run.candidatePo || run.execution !== "AWAITING_CONFIRMATION")
    )
      context.addIssue({
        code: "custom",
        message:
          "Awaiting-PO runs require a candidate and confirmation execution.",
      });
    if (
      run.state === "AWAITING_BUNDLE_CONFIRMATION" &&
      (!run.bundleCandidates.length ||
        run.execution !== "AWAITING_CONFIRMATION")
    )
      context.addIssue({
        code: "custom",
        message:
          "Awaiting-bundle runs require candidates and confirmation execution.",
      });
  });

export const runSummarySchema = z.object({
  runId: z.uuid(),
  filename: z.string(),
  vendor: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  total: z.string().nullable(),
  currency: z.literal("USD").nullable(),
  state: runStateSchema,
  decision: z.enum(["AUTO_CLEARED", "NEEDS_REVIEW"]).nullable(),
  execution: z.enum(["POSTED", "BLOCKED", "AWAITING_CONFIRMATION"]).nullable(),
  reasonCode: z.string().nullable(),
  ledgerId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const runListSchema = z.object({
  items: z.array(runSummarySchema),
  nextCursor: z.string().nullable(),
  metrics: z.object({
    totalRuns: z.number().int().nonnegative(),
    postedCount: z.number().int().nonnegative(),
    reviewCount: z.number().int().nonnegative(),
    autoClearRate: z.string(),
  }),
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    runId: z.uuid().optional(),
  }),
});

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type StageEvent = z.infer<typeof stageEventSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type NormalizedInvoice = z.infer<typeof normalizedInvoiceSchema>;
export type Allocation = z.infer<typeof allocationSchema>;
export type BundleCandidate = z.infer<typeof bundleCandidateSchema>;
export type PoCandidate = z.infer<typeof poCandidateSchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunList = z.infer<typeof runListSchema>;
