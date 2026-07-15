import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A small in-memory fake standing in for Prisma — faithful enough to
// exercise the REAL engine/idempotency/executor/validator/planner modules
// together (this is the actual end-to-end wiring), while keeping `npm test`
// hermetic (no live DB requirement). HubSpot is mocked at the v1 tool-layer
// boundary per CLAUDE.md ("HubSpot mocked ... never hit real HubSpot in
// tests") — everything else in this test is real code, not mocks of our
// own logic.
const { fakeDb, messagesCreateMock, hubspotGetMock, activityLogCreateMock, sideEffectCalls } = vi.hoisted(
  () => ({
    fakeDb: new (class {
      workflows = new Map<string, Record<string, unknown>>();
      steps = new Map<string, Record<string, unknown>>();
      auditLog: Record<string, unknown>[] = [];
      stepIdCounter = 0;
    })(),
    messagesCreateMock: vi.fn(),
    hubspotGetMock: vi.fn(),
    activityLogCreateMock: vi.fn(),
    sideEffectCalls: [] as { tool: string; workflowState: unknown }[],
  }),
);

function makePrismaMock() {
  return {
    workflow: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `wf-${fakeDb.workflows.size + 1}`;
        const row = { id, state: "TRIAGED", ...data };
        fakeDb.workflows.set(id, row);
        return { ...row };
      },
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        const row = fakeDb.workflows.get(id);
        return row ? { ...row } : null;
      },
      update: async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = fakeDb.workflows.get(id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return { ...row };
      },
    },
    workflowStep: {
      findUnique: async ({
        where: { workflowId_stepIndex },
      }: {
        where: { workflowId_stepIndex: { workflowId: string; stepIndex: number } };
      }) => {
        const row = fakeDb.steps.get(`${workflowId_stepIndex.workflowId}:${workflowId_stepIndex.stepIndex}`);
        return row ? { ...row } : null;
      },
      upsert: async ({
        where: { workflowId_stepIndex },
        create,
        update,
      }: {
        where: { workflowId_stepIndex: { workflowId: string; stepIndex: number } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const key = `${workflowId_stepIndex.workflowId}:${workflowId_stepIndex.stepIndex}`;
        const existing = fakeDb.steps.get(key);
        const row = existing ? { ...existing, ...update } : { id: `step-${++fakeDb.stepIdCounter}`, ...create };
        fakeDb.steps.set(key, row);
        return { ...row };
      },
      update: async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        for (const row of fakeDb.steps.values()) {
          if (row.id === id) {
            Object.assign(row, data);
            return { ...row };
          }
        }
        throw new Error("step not found");
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        fakeDb.auditLog.push(data);
        return { ...data };
      },
    },
    activityLog: { create: activityLogCreateMock },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
          const workflowId = values[0] as string;
          const row = fakeDb.workflows.get(workflowId);
          return row ? [{ id: row.id, state: row.state }] : [];
        },
        workflow: prismaMockRef.workflow,
        auditLog: prismaMockRef.auditLog,
      };
      return cb(tx);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prismaMockRef: any;

vi.mock("../../src/db/client", () => {
  prismaMockRef = makePrismaMock();
  return { prisma: prismaMockRef };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreateMock };
  },
}));

vi.mock("../../src/planner/rag", () => ({ queryPolicyDocs: vi.fn().mockResolvedValue([]) }));

vi.mock("../../src/integrations/hubspot/client", () => ({
  hubspotGet: (...args: unknown[]) => {
    sideEffectCalls.push({ tool: "hubspot.get_contact", workflowState: currentWorkflowStateSnapshot() });
    return hubspotGetMock(...args);
  },
  hubspotPatch: vi.fn(),
  hubspotPost: vi.fn(),
  HubspotApiError: class HubspotApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
}));

let trackedWorkflowId: string;
function currentWorkflowStateSnapshot(): unknown {
  return trackedWorkflowId ? fakeDb.workflows.get(trackedWorkflowId)?.state : undefined;
}

// activityLog.create is used by the email.draft tool executor — also a
// side-effecting call, tracked the same way.
activityLogCreateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
  sideEffectCalls.push({ tool: "email.draft", workflowState: currentWorkflowStateSnapshot() });
  return { id: "activity-log-1", ...data };
});

const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");
function loadFixture(relPath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, relPath), "utf8"));
}

describe("end-to-end happy path: trigger -> plan -> validate -> approve -> execute -> DONE", () => {
  beforeEach(() => {
    fakeDb.workflows.clear();
    fakeDb.steps.clear();
    fakeDb.auditLog.length = 0;
    sideEffectCalls.length = 0;
    messagesCreateMock.mockReset();
    hubspotGetMock.mockReset();
    activityLogCreateMock.mockClear();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("runs the full lifecycle and never invokes a side-effect tool outside EXECUTING", async () => {
    const { planWorkflow } = await import("../../src/planner/planner");
    const { validatePlan } = await import("../../src/planner/validator");
    const { workflowEngine } = await import("../../src/workflow/engine");
    const { executeWorkflow } = await import("../../src/workflow/executor");
    const { prisma } = await import("../../src/db/client");

    const trigger = loadFixture("triggers/inbound-email.json");
    const fixturePlan = loadFixture("plans/lead-routing-plan.json");
    messagesCreateMock.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify(fixturePlan) }] });
    hubspotGetMock.mockResolvedValue({
      id: "hs-contact-42",
      properties: { email: "lead@example.com" },
    });

    // 1. Trigger -> Planner (real generatePlan/validatePlan wiring, LLM mocked).
    const plan = await planWorkflow({ workflowId: "pending", triggerPayload: trigger });
    const validation = validatePlan(plan, { triggerPayload: trigger });
    expect(validation).toEqual({ valid: true, reasons: [] });

    // 2. Create the workflow row and drive it through the real state machine.
    const workflow = await prisma.workflow.create({
      data: { triggerType: "inbound_email", triggerPayload: trigger },
    });
    trackedWorkflowId = workflow.id;

    await workflowEngine.transition(workflow.id, "CREATE_PLAN", {
      plan,
      planSummary: plan.human_summary,
    });
    await workflowEngine.transition(workflow.id, "SUBMIT_FOR_APPROVAL");
    expect((await prisma.workflow.findUnique({ where: { id: workflow.id } }))?.state).toBe(
      "AWAITING_APPROVAL",
    );

    // No side-effect tool should have run yet — plan/validate never touch HubSpot.
    expect(sideEffectCalls).toEqual([]);

    // 3. Approve (simulating an allowlisted Telegram/Slack click — those
    // callback paths are exercised directly in Issue 12/Slack's own tests).
    await workflowEngine.transition(workflow.id, "APPROVE", { approvedBy: "victor" });

    // 4. Execute for real.
    const result = await executeWorkflow(workflow.id, { sleep: async () => {} });

    expect(result.status).toBe("DONE");
    const final = await prisma.workflow.findUnique({ where: { id: workflow.id } });
    expect(final?.state).toBe("DONE");

    // The invariant test (CLAUDE.md): every side-effect tool invocation
    // happened while the workflow was EXECUTING — never before APPROVED.
    expect(sideEffectCalls.length).toBeGreaterThan(0);
    for (const call of sideEffectCalls) {
      expect(call.workflowState).toBe("EXECUTING");
    }

    // Full audit trail present, in order.
    const events = fakeDb.auditLog.map((e) => e.event);
    expect(events).toEqual([
      "state_transition", // CREATE_PLAN
      "state_transition", // SUBMIT_FOR_APPROVAL
      "state_transition", // APPROVE
      "state_transition", // START_EXECUTION
      "step_started",
      "step_executed",
      "step_started",
      "step_executed",
      "state_transition", // COMPLETE
    ]);
  });
});
