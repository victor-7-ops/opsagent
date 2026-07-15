import { describe, expect, it } from "vitest";
import { Plan } from "./plan";
import { validatePlan } from "./validator";

function plan(overrides: Partial<Plan>): Plan {
  return {
    goal: "test goal",
    risk_level: "low",
    steps: [
      {
        tool: "hubspot.get_contact",
        args: { contactId: "123" },
        rationale: "resolve contact",
        depends_on: [],
      },
    ],
    human_summary: "test summary",
    ...overrides,
  };
}

const TRIGGER_WITH_CONTACT = { contactId: "123" };

describe("validatePlan", () => {
  it("accepts a well-formed, resolvable plan", () => {
    const result = validatePlan(plan({}), { triggerPayload: TRIGGER_WITH_CONTACT });
    expect(result).toEqual({ valid: true, reasons: [] });
  });

  it("rejects risk_level=high unconditionally", () => {
    const result = validatePlan(plan({ risk_level: "high" }), { triggerPayload: TRIGGER_WITH_CONTACT });
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("risk_level=high plans are always rejected")]),
    );
  });

  it("rejects an unknown tool", () => {
    const p = plan({
      steps: [{ tool: "hubspot.delete_contact", args: {}, rationale: "x", depends_on: [] }],
    });
    const result = validatePlan(p, { triggerPayload: {} });
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([expect.stringContaining("unknown tool")]));
  });

  it("rejects args that fail the tool's schema", () => {
    const p = plan({
      steps: [
        {
          tool: "email.send",
          args: { to: "not-an-email", subject: "hi", body: "hello" },
          rationale: "x",
          depends_on: [],
        },
      ],
    });
    const result = validatePlan(p, { triggerPayload: {} });
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("failed validation")]),
    );
  });

  it("rejects maxPerPlan exceeded (email.send capped at 1)", () => {
    const step = {
      tool: "email.send",
      args: { to: "a@example.com", subject: "hi", body: "hello" },
      rationale: "x",
      depends_on: [],
    };
    const p = plan({ steps: [step, step] });
    const result = validatePlan(p, { triggerPayload: {} });
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("exceeding maxPerPlan")]),
    );
  });

  it("rejects a dependency cycle", () => {
    const p = plan({
      steps: [
        { tool: "hubspot.get_contact", args: { contactId: "1" }, rationale: "a", depends_on: [1] },
        { tool: "hubspot.get_contact", args: { contactId: "1" }, rationale: "b", depends_on: [0] },
      ],
    });
    const result = validatePlan(p, { triggerPayload: {} });
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("Dependency cycle")]),
    );
  });

  it("rejects depends_on pointing to a later or out-of-range step", () => {
    const p = plan({
      steps: [
        { tool: "hubspot.get_contact", args: { contactId: "1" }, rationale: "a", depends_on: [5] },
      ],
    });
    const result = validatePlan(p, { triggerPayload: {} });
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("out-of-range step index")]),
    );
  });

  it("accepts an entity ID present in the trigger payload", () => {
    const p = plan({
      steps: [
        { tool: "hubspot.get_contact", args: { contactId: "abc-123" }, rationale: "x", depends_on: [] },
      ],
    });
    const result = validatePlan(p, { triggerPayload: { contactId: "abc-123" } });
    expect(result.valid).toBe(true);
  });

  it("accepts an entity ID resolved via a prior read step's templated result", () => {
    const p = plan({
      steps: [
        { tool: "hubspot.get_contact", args: { contactId: "1" }, rationale: "read", depends_on: [] },
        {
          tool: "hubspot.update_contact",
          args: { contactId: "{{steps.0.result.contact_id}}", properties: { lifecycle: "lead" } },
          rationale: "update",
          depends_on: [0],
        },
      ],
    });
    const result = validatePlan(p, { triggerPayload: { contactId: "1" } });
    expect(result.valid).toBe(true);
  });

  it("rejects an invented entity ID with no trigger payload or read-step provenance", () => {
    const p = plan({
      steps: [
        {
          tool: "hubspot.update_contact",
          args: { contactId: "invented-999", properties: {} },
          rationale: "x",
          depends_on: [],
        },
      ],
    });
    const result = validatePlan(p, { triggerPayload: { unrelated: "field" } });
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("not present in the trigger payload")]),
    );
  });

  it("rejects a templated ID referencing a step that is not a read", () => {
    const p = plan({
      steps: [
        {
          tool: "email.draft",
          args: { to: "a@example.com", subject: "x", body: "y" },
          rationale: "draft",
          depends_on: [],
        },
        {
          tool: "hubspot.update_contact",
          args: { contactId: "{{steps.0.result.contact_id}}", properties: {} },
          rationale: "x",
          depends_on: [0],
        },
      ],
    });
    const result = validatePlan(p, { triggerPayload: {} });
    expect(result.valid).toBe(false);
  });

  it("rejects a templated ID referencing a later step", () => {
    const p = plan({
      steps: [
        {
          tool: "hubspot.update_contact",
          args: { contactId: "{{steps.1.result.contact_id}}", properties: {} },
          rationale: "x",
          depends_on: [],
        },
        { tool: "hubspot.get_contact", args: { contactId: "1" }, rationale: "read", depends_on: [] },
      ],
    });
    const result = validatePlan(p, { triggerPayload: {} });
    expect(result.valid).toBe(false);
  });

  it("collects multiple distinct rejection reasons at once", () => {
    const p = plan({
      risk_level: "high",
      steps: [{ tool: "not.a.tool", args: {}, rationale: "x", depends_on: [] }],
    });
    const result = validatePlan(p, { triggerPayload: {} });
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});
