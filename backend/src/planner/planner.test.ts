import { beforeEach, describe, expect, it, vi } from "vitest";

const { messagesCreateMock, auditLogCreateMock, queryPolicyDocsMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
  auditLogCreateMock: vi.fn().mockResolvedValue({}),
  queryPolicyDocsMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreateMock };
  },
}));

vi.mock("../db/client", () => ({ prisma: { auditLog: { create: auditLogCreateMock } } }));
vi.mock("./rag", () => ({ queryPolicyDocs: queryPolicyDocsMock }));

import {
  generatePlan,
  parsePlan,
  PlanParseError,
  PlannerDeadLetterError,
  buildPlannerPrompt,
  planWorkflow,
} from "./planner";

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

describe("planWorkflow", () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    queryPolicyDocsMock.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("retrieves RAG chunks and passes them into the planner prompt", async () => {
    queryPolicyDocsMock.mockResolvedValue(["refund policy chunk"]);
    messagesCreateMock.mockResolvedValueOnce(textResponse(VALID_RAW_PLAN));

    await planWorkflow({ workflowId: "wf-1", triggerPayload: { type: "refund_request" } });

    expect(queryPolicyDocsMock).toHaveBeenCalledWith(JSON.stringify({ type: "refund_request" }));
    const promptSent = messagesCreateMock.mock.calls[0][0].messages[0].content;
    expect(promptSent).toContain("refund policy chunk");
  });

  it("uses an explicit ragQuery when provided instead of the trigger payload", async () => {
    queryPolicyDocsMock.mockResolvedValue([]);
    messagesCreateMock.mockResolvedValueOnce(textResponse(VALID_RAW_PLAN));

    await planWorkflow({ workflowId: "wf-1", triggerPayload: {}, ragQuery: "custom query" });

    expect(queryPolicyDocsMock).toHaveBeenCalledWith("custom query");
  });
});
