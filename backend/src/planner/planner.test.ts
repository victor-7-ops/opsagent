import { beforeEach, describe, expect, it, vi } from "vitest";

const { messagesCreateMock, auditLogCreateMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
  auditLogCreateMock: vi.fn().mockResolvedValue({}),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreateMock };
  },
}));

vi.mock("../db/client", () => ({ prisma: { auditLog: { create: auditLogCreateMock } } }));

import { generatePlan, parsePlan, PlanParseError, PlannerDeadLetterError, buildPlannerPrompt } from "./planner";

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

const VALID_RAW_PLAN = JSON.stringify({
  goal: "Route lead",
  risk_level: "low",
  steps: [
    { tool: "hubspot.get_contact", args: { contactId: "1" }, rationale: "resolve id", depends_on: [] },
  ],
  human_summary: "Look up the lead.",
});

describe("parsePlan", () => {
  it("parses and validates well-formed JSON", () => {
    const plan = parsePlan(VALID_RAW_PLAN);
    expect(plan.goal).toBe("Route lead");
  });

  it("throws PlanParseError on invalid JSON", () => {
    expect(() => parsePlan("not json")).toThrow(PlanParseError);
  });

  it("throws PlanParseError on JSON that doesn't match the schema", () => {
    expect(() => parsePlan(JSON.stringify({ foo: "bar" }))).toThrow(PlanParseError);
  });
});

describe("buildPlannerPrompt", () => {
  it("embeds the tool registry, hard rules, and trigger payload", () => {
    const prompt = buildPlannerPrompt({ workflowId: "wf-1", triggerPayload: { hello: "world" } });
    expect(prompt).toContain("hubspot.get_contact");
    expect(prompt).toContain("Never invent entity IDs");
    expect(prompt).toContain('"hello": "world"');
  });

  it("includes RAG chunks when provided", () => {
    const prompt = buildPlannerPrompt({
      workflowId: "wf-1",
      triggerPayload: {},
      ragChunks: ["policy chunk 1", "policy chunk 2"],
    });
    expect(prompt).toContain("policy chunk 1");
    expect(prompt).toContain("policy chunk 2");
  });
});

describe("generatePlan", () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    auditLogCreateMock.mockClear();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("returns a validated plan on first success", async () => {
    messagesCreateMock.mockResolvedValueOnce(textResponse(VALID_RAW_PLAN));

    const plan = await generatePlan({ workflowId: "wf-1", triggerPayload: {} });

    expect(plan.goal).toBe("Route lead");
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    expect(auditLogCreateMock).not.toHaveBeenCalled();
  });

  it("retries once on parse failure, then succeeds", async () => {
    messagesCreateMock
      .mockResolvedValueOnce(textResponse("not json"))
      .mockResolvedValueOnce(textResponse(VALID_RAW_PLAN));

    const plan = await generatePlan({ workflowId: "wf-1", triggerPayload: {} });

    expect(plan.goal).toBe("Route lead");
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
    expect(auditLogCreateMock).not.toHaveBeenCalled();
  });

  it("dead-letters (audit_log write + throw) after 2 failed attempts", async () => {
    messagesCreateMock
      .mockResolvedValueOnce(textResponse("not json"))
      .mockResolvedValueOnce(textResponse("still not json"));

    await expect(generatePlan({ workflowId: "wf-1", triggerPayload: {} })).rejects.toThrow(
      PlannerDeadLetterError,
    );
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workflowId: "wf-1", actor: "planner", event: "plan_rejected" }),
      }),
    );
  });
});
