import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { messagesCreateMock, auditLogCreateMock, queryPolicyDocsMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
  auditLogCreateMock: vi.fn().mockResolvedValue({}),
  queryPolicyDocsMock: vi.fn().mockResolvedValue([]),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreateMock };
  },
}));
vi.mock("../db/client", () => ({ prisma: { auditLog: { create: auditLogCreateMock } } }));
vi.mock("./rag", () => ({ queryPolicyDocs: queryPolicyDocsMock }));

import { planWorkflow } from "./planner";
import { PlanSchema } from "./plan";
import { validatePlan } from "./validator";

const FIXTURES_DIR = path.resolve(__dirname, "../../tests/fixtures");

function loadFixture(relPath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, relPath), "utf8"));
}

describe("integration: inbound email fixture -> valid plan", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("produces a plan that parses, validates against zod, and passes the plan validator", async () => {
    const trigger = loadFixture("triggers/inbound-email.json");
    const fixturePlan = loadFixture("plans/lead-routing-plan.json");

    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(fixturePlan) }],
    });

    const plan = await planWorkflow({ workflowId: "wf-integration", triggerPayload: trigger });

    // Round-trips through the real Plan schema, not just the fixture's shape.
    expect(PlanSchema.safeParse(plan).success).toBe(true);

    const result = validatePlan(plan, { triggerPayload: trigger });
    expect(result).toEqual({ valid: true, reasons: [] });

    // Sanity: the produced plan is the low-risk, read-before-write shape we expect.
    expect(plan.risk_level).toBe("low");
    expect(plan.steps[0].tool).toBe("hubspot.get_contact");
    expect(plan.steps.some((s) => s.tool === "email.send")).toBe(false);
  });

  it("rejects a fixture plan that violates the hard rules (regression guard)", async () => {
    const trigger = loadFixture("triggers/inbound-email.json");
    const badPlan = {
      goal: "Send immediately without checking anything",
      risk_level: "high",
      steps: [
        {
          tool: "email.send",
          args: { to: "lead@example.com", subject: "hi", body: "hi" },
          rationale: "just send it",
          depends_on: [],
        },
      ],
      human_summary: "Sends an email directly.",
    };

    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(badPlan) }],
    });

    const plan = await planWorkflow({ workflowId: "wf-integration-bad", triggerPayload: trigger });
    const result = validatePlan(plan, { triggerPayload: trigger });

    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("risk_level=high plans are always rejected")]),
    );
  });
});
