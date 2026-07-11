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
});

export const invoiceLineSchema = z.object({
  sku: z.string(),
  description: z.string(),
  quantity: z.string(),
  uom: z.string(),
  unitPrice: z.string(),
  amount: z.string(),
});

export const normalizedInvoiceSchema = z.object({
  vendor: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.iso.date(),
  poNumber: z.string(),
  currency: z.literal("USD"),
  subtotal: z.string(),
  tax: z.string(),
  total: z.string(),
  lines: z.array(invoiceLineSchema).min(1),
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
});

export const runDetailSchema = z.object({
  runId: z.uuid(),
  filename: z.string(),
  state: runStateSchema,
  decision: z.enum(["AUTO_CLEARED", "NEEDS_REVIEW"]).nullable(),
  execution: z.enum(["POSTED", "BLOCKED", "AWAITING_CONFIRMATION"]).nullable(),
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
export type RunDetail = z.infer<typeof runDetailSchema>;
