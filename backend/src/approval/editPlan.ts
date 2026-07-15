import { Plan } from "../planner/plan";
import { PlanValidationResult, validatePlan } from "../planner/validator";

export class StepIndexOutOfRangeError extends Error {
  constructor(stepIndex: number, stepCount: number) {
    super(`Step index ${stepIndex} is out of range (plan has ${stepCount} steps)`);
    this.name = "StepIndexOutOfRangeError";
  }
}

// The args the executor would actually run: an approver's edit if present,
// otherwise the LLM's original proposal (SPEC.md §6 — edited_args reserved).
export function effectivePlan(plan: Plan): Plan {
  return {
    ...plan,
    steps: plan.steps.map((step) => ({ ...step, args: step.edited_args ?? step.args })),
  };
}

export interface EditPlanStepResult {
  plan: Plan;
  validation: PlanValidationResult;
}

// Applies an approver's edit to one step's args, then re-validates the
// *effective* plan (edits included) — an edit that breaks a registry/entity
// rule must not silently pass. The original `args` are preserved; only
// `edited_args` is set, so the LLM's proposal stays auditable.
export function editPlanStep(
  plan: Plan,
  stepIndex: number,
  args: Record<string, unknown>,
  triggerPayload: unknown,
): EditPlanStepResult {
  if (stepIndex < 0 || stepIndex >= plan.steps.length) {
    throw new StepIndexOutOfRangeError(stepIndex, plan.steps.length);
  }

  const updatedPlan: Plan = {
    ...plan,
    steps: plan.steps.map((step, i) => (i === stepIndex ? { ...step, edited_args: args } : step)),
  };

  const validation = validatePlan(effectivePlan(updatedPlan), { triggerPayload });
  return { plan: updatedPlan, validation };
}
