import { z } from "zod";

// SPEC.md §5.2 — the structured plan contract Claude must emit.
export const PlanStepSchema = z.object({
  tool: z.string(), // must exist in registry — checked by the validator (Issue 9), not here
  args: z.record(z.unknown()),
  rationale: z.string().max(300),
  depends_on: z.array(z.number().int()).default([]),
});

export const PlanSchema = z.object({
  goal: z.string().max(300),
  risk_level: z.enum(["low", "medium", "high"]),
  steps: z.array(PlanStepSchema).min(1).max(10),
  human_summary: z.string().max(600),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Plan = z.infer<typeof PlanSchema>;
