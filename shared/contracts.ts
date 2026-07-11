import { z } from "zod";

export const runStateSchema = z.enum([
  "PROCESSING",
  "POSTED",
  "AWAITING_PO_CONFIRMATION",
  "AWAITING_BUNDLE_CONFIRMATION",
  "NEEDS_REVIEW",
]);

export const decisionSchema = z.enum(["AUTO_CLEARED", "NEEDS_REVIEW"]);
export const executionSchema = z.enum(["POSTED", "BLOCKED", "AWAITING_CONFIRMATION"]);

export const sourceRefSchema = z.object({
  id: z.string().min(1),
  value: z.string(),
  confidence: z.string().regex(/^\d+(\.\d+)?$/),
  page: z.number().int().positive(),
});

export const stageEventSchema = z.object({
  stage: z.string().min(1),
  status: z.enum(["PENDING", "ACTIVE", "COMPLETED", "FAILED"]),
  at: z.iso.datetime(),
});

export const checkResultSchema = z.object({
  code: z.string().min(1),
  passed: z.boolean(),
  observed: z.string().optional(),
  expected: z.string().optional(),
});

const runBaseSchema = z.object({
  runId: z.uuid(),
  stages: z.array(stageEventSchema),
  checks: z.array(checkResultSchema),
});

export const processResultSchema = z.discriminatedUnion("state", [
  runBaseSchema.extend({ state: z.literal("PROCESSING") }),
  runBaseSchema.extend({
    state: z.literal("POSTED"),
    decision: z.literal("AUTO_CLEARED"),
    execution: z.literal("POSTED"),
    ledgerId: z.string().min(1),
  }),
  runBaseSchema.extend({
    state: z.literal("AWAITING_PO_CONFIRMATION"),
    decision: z.literal("NEEDS_REVIEW"),
    execution: z.literal("AWAITING_CONFIRMATION"),
    poCandidates: z.array(z.string().min(1)).min(1),
  }),
  runBaseSchema.extend({
    state: z.literal("AWAITING_BUNDLE_CONFIRMATION"),
    decision: z.literal("NEEDS_REVIEW"),
    execution: z.literal("AWAITING_CONFIRMATION"),
    bundleCandidates: z.array(z.string().min(1)).min(1),
  }),
  runBaseSchema.extend({
    state: z.literal("NEEDS_REVIEW"),
    decision: z.literal("NEEDS_REVIEW"),
    execution: z.literal("BLOCKED"),
    reasonCode: z.string().min(1),
    nextAction: z.string().min(1),
  }),
]);

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    runId: z.uuid().optional(),
  }),
});

export type RunState = z.infer<typeof runStateSchema>;
export type ProcessResult = z.infer<typeof processResultSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
