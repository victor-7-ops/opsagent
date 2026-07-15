import { describe, expect, it } from "vitest";
import { Plan } from "../planner/plan";
import { editPlanStep, effectivePlan, StepIndexOutOfRangeError } from "./editPlan";

const BASE_PLAN: Plan = {
  goal: "Route lead",
  risk_level: "low",
  steps: [
    { tool: "hubspot.get_contact", args: { contactId: "1" }, rationale: "read", depends_on: [] },
    {
      tool: "email.draft",
      args: { to: "old@example.com", subject: "hi", body: "hello" },
      rationale: "draft",
      depends_on: [0],
    },
  ],
  human_summary: "Look up the lead and draft a reply.",
};

describe("effectivePlan", () => {
  it("uses edited_args over args when present", () => {
    const plan: Plan = {
      ...BASE_PLAN,
      steps: [
        BASE_PLAN.steps[0],
        { ...BASE_PLAN.steps[1], edited_args: { to: "new@example.com", subject: "hi", body: "hello" } },
      ],
    };
    const effective = effectivePlan(plan);
    expect(effective.steps[1].args).toEqual({ to: "new@example.com", subject: "hi", body: "hello" });
    expect(effective.steps[0].args).toEqual({ contactId: "1" }); // untouched
  });

  it("falls back to args when edited_args is absent", () => {
    const effective = effectivePlan(BASE_PLAN);
    expect(effective.steps[1].args).toEqual(BASE_PLAN.steps[1].args);
  });
});

describe("editPlanStep", () => {
  it("sets edited_args on the target step, leaves args untouched, and validates clean", () => {
    const result = editPlanStep(
      BASE_PLAN,
      1,
      { to: "new@example.com", subject: "hi", body: "hello" },
      { contactId: "1" },
    );

    expect(result.plan.steps[1].args).toEqual(BASE_PLAN.steps[1].args); // original preserved
    expect(result.plan.steps[1].edited_args).toEqual({
      to: "new@example.com",
      subject: "hi",
      body: "hello",
    });
    expect(result.plan.steps[0]).toEqual(BASE_PLAN.steps[0]); // other steps untouched
    expect(result.validation).toEqual({ valid: true, reasons: [] });
  });

  it("throws StepIndexOutOfRangeError for an invalid step index", () => {
    expect(() => editPlanStep(BASE_PLAN, 99, {}, {})).toThrow(StepIndexOutOfRangeError);
    expect(() => editPlanStep(BASE_PLAN, -1, {}, {})).toThrow(StepIndexOutOfRangeError);
  });

  it("flags an edit that breaks tool arg validation", () => {
    const result = editPlanStep(BASE_PLAN, 1, { to: "not-an-email", subject: "hi", body: "hello" }, {});
    expect(result.validation.valid).toBe(false);
    expect(result.validation.reasons.some((r) => r.includes("failed validation"))).toBe(true);
  });

  it("flags an edit that introduces an unresolvable entity ID", () => {
    const result = editPlanStep(BASE_PLAN, 0, { contactId: "invented-999" }, { contactId: "1" });
    expect(result.validation.valid).toBe(false);
    expect(result.validation.reasons.some((r) => r.includes("not present in the trigger payload"))).toBe(
      true,
    );
  });
});
