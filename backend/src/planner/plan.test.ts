import { describe, expect, it } from "vitest";
import { PlanSchema } from "./plan";

const VALID_PLAN = {
  goal: "Route new lead to sales rep",
  risk_level: "low",
  steps: [
    {
      tool: "hubspot.get_contact",
      args: { contactId: "123" },
      rationale: "Resolve contact details before acting",
      depends_on: [],
    },
    {
      tool: "email.draft",
      args: { to: "lead@example.com", subject: "Welcome", body: "Hi there" },
      rationale: "Draft a welcome email for human review",
      depends_on: [0],
    },
  ],
  human_summary: "Look up the new lead and draft a welcome email for approval.",
};

describe("PlanSchema", () => {
  it("accepts a well-formed plan", () => {
    const result = PlanSchema.safeParse(VALID_PLAN);
    expect(result.success).toBe(true);
  });

  it("defaults depends_on to an empty array when omitted", () => {
    const { depends_on: _omit, ...stepWithoutDeps } = VALID_PLAN.steps[0];
    const plan = { ...VALID_PLAN, steps: [stepWithoutDeps] };
    const result = PlanSchema.parse(plan);
    expect(result.steps[0].depends_on).toEqual([]);
  });

  it("rejects an empty steps array", () => {
    expect(PlanSchema.safeParse({ ...VALID_PLAN, steps: [] }).success).toBe(false);
  });

  it("rejects more than 10 steps", () => {
    const steps = Array.from({ length: 11 }, (_, i) => ({
      tool: "hubspot.get_contact",
      args: { contactId: String(i) },
      rationale: "x",
      depends_on: [],
    }));
    expect(PlanSchema.safeParse({ ...VALID_PLAN, steps }).success).toBe(false);
  });

  it("rejects an invalid risk_level", () => {
    expect(PlanSchema.safeParse({ ...VALID_PLAN, risk_level: "extreme" }).success).toBe(false);
  });

  it("rejects a rationale over 300 chars", () => {
    const steps = [{ ...VALID_PLAN.steps[0], rationale: "x".repeat(301) }];
    expect(PlanSchema.safeParse({ ...VALID_PLAN, steps }).success).toBe(false);
  });

  it("rejects a human_summary over 600 chars", () => {
    expect(
      PlanSchema.safeParse({ ...VALID_PLAN, human_summary: "x".repeat(601) }).success,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(PlanSchema.safeParse({}).success).toBe(false);
  });
});
