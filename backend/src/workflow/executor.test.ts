import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  workflowFindUniqueMock,
  workflowStepFindUniqueMock,
  workflowStepUpsertMock,
  workflowStepUpdateMock,
  transitionMock,
  writeAuditLogMock,
  sendFailureSummaryMock,
  toolExecutorMocks,
} = vi.hoisted(() => ({
  workflowFindUniqueMock: vi.fn(),
  workflowStepFindUniqueMock: vi.fn(),
  workflowStepUpsertMock: vi.fn(),
  workflowStepUpdateMock: vi.fn(),
  transitionMock: vi.fn(),
  writeAuditLogMock: vi.fn().mockResolvedValue(undefined),
  sendFailureSummaryMock: vi.fn().mockResolvedValue(undefined),
  toolExecutorMocks: {
    "hubspot.get_contact": vi.fn(),
    "email.draft": vi.fn(),
  } as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("../db/client", () => ({
  prisma: {
    workflow: { findUnique: workflowFindUniqueMock },
    workflowStep: {
      findUnique: workflowStepFindUniqueMock,
      upsert: workflowStepUpsertMock,
      update: workflowStepUpdateMock,
    },
  },
}));
vi.mock("./engine", () => ({ workflowEngine: { transition: transitionMock } }));
vi.mock("./audit", () => ({ writeAuditLog: writeAuditLogMock }));
vi.mock("../approval/notifier", () => ({
  getNotifier: () => ({ sendFailureSummary: sendFailureSummaryMock }),
}));
vi.mock("./toolExecutors", () => ({ TOOL_EXECUTORS: toolExecutorMocks }));

import { HubspotApiError } from "../integrations/hubspot/client";
import { executeWorkflow } from "./executor";

function planWith(steps: Array<{ tool: string; args: Record<string, unknown>; depends_on?: number[] }>) {
  return {
    goal: "test",
    risk_level: "low",
    steps: steps.map((s) => ({ rationale: "x", depends_on: [], ...s })),
    human_summary: "test",
  };
}

function workflowRow(overrides: Partial<{ state: string; plan: unknown }> = {}) {
  return { id: "wf-1", state: "APPROVED", plan: planWith([]), ...overrides };
}

describe("executeWorkflow", () => {
  const noopSleep = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    workflowFindUniqueMock.mockReset();
    workflowStepFindUniqueMock.mockReset().mockResolvedValue(undefined); // no prior run by default
    workflowStepUpsertMock.mockReset().mockResolvedValue({ id: "ws-1" });
    workflowStepUpdateMock.mockReset().mockResolvedValue({});
    transitionMock.mockReset().mockResolvedValue({});
    writeAuditLogMock.mockClear();
    sendFailureSummaryMock.mockClear();
    noopSleep.mockClear();
    for (const fn of Object.values(toolExecutorMocks)) fn.mockReset();
  });

  it("is a no-op that returns immediately for a DONE workflow", async () => {
    workflowFindUniqueMock.mockResolvedValue(workflowRow({ state: "DONE" }));
    const result = await executeWorkflow("wf-1");
    expect(result).toEqual({ status: "DONE", results: {} });
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("is a no-op that returns immediately for a FAILED workflow", async () => {
    workflowFindUniqueMock.mockResolvedValue(workflowRow({ state: "FAILED" }));
    const result = await executeWorkflow("wf-1");
    expect(result).toEqual({ status: "FAILED", results: {} });
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("throws for a workflow in a non-executable state", async () => {
    workflowFindUniqueMock.mockResolvedValue(workflowRow({ state: "TRIAGED" }));
    await expect(executeWorkflow("wf-1")).rejects.toThrow("Cannot execute workflow wf-1 in state TRIAGED");
  });

  it("transitions APPROVED -> EXECUTING -> DONE and runs all steps in order", async () => {
    workflowFindUniqueMock.mockResolvedValue(
      workflowRow({
        plan: planWith([
          { tool: "hubspot.get_contact", args: { contactId: "42" } },
          { tool: "email.draft", args: { to: "a@example.com", subject: "hi", body: "hello" } },
        ]),
      }),
    );
    toolExecutorMocks["hubspot.get_contact"].mockResolvedValue({ contact_id: "42" });
    toolExecutorMocks["email.draft"].mockResolvedValue({ draftId: "d1" });

    const result = await executeWorkflow("wf-1", { sleep: noopSleep });

    expect(transitionMock).toHaveBeenNthCalledWith(1, "wf-1", "START_EXECUTION", {}, "executor");
    expect(transitionMock).toHaveBeenNthCalledWith(2, "wf-1", "COMPLETE", {}, "executor");
    expect(result).toEqual({
      status: "DONE",
      results: { 0: { contact_id: "42" }, 1: { draftId: "d1" } },
    });
  });

  it("resolves templated args from a prior step's result", async () => {
    workflowFindUniqueMock.mockResolvedValue(
      workflowRow({
        plan: planWith([
          { tool: "hubspot.get_contact", args: { contactId: "42" } },
          {
            tool: "email.draft",
            args: { to: "{{steps.0.result.email}}", subject: "hi", body: "hello" },
            depends_on: [0],
          },
        ]),
      }),
    );
    toolExecutorMocks["hubspot.get_contact"].mockResolvedValue({ email: "resolved@example.com" });
    toolExecutorMocks["email.draft"].mockResolvedValue({ draftId: "d1" });

    await executeWorkflow("wf-1", { sleep: noopSleep });

    expect(toolExecutorMocks["email.draft"]).toHaveBeenCalledWith(
      expect.objectContaining({ to: "resolved@example.com" }),
    );
  });

  it("skips a resume from EXECUTING without re-transitioning START_EXECUTION", async () => {
    workflowFindUniqueMock.mockResolvedValue(
      workflowRow({ state: "EXECUTING", plan: planWith([{ tool: "hubspot.get_contact", args: { contactId: "1" } }]) }),
    );
    toolExecutorMocks["hubspot.get_contact"].mockResolvedValue({});

    await executeWorkflow("wf-1", { sleep: noopSleep });

    expect(transitionMock).not.toHaveBeenCalledWith("wf-1", "START_EXECUTION", expect.anything(), expect.anything());
    expect(transitionMock).toHaveBeenCalledWith("wf-1", "COMPLETE", {}, "executor");
  });

  it("does not retry a non-retryable (4xx) failure", async () => {
    workflowFindUniqueMock.mockResolvedValue(
      workflowRow({ plan: planWith([{ tool: "hubspot.get_contact", args: { contactId: "1" } }]) }),
    );
    toolExecutorMocks["hubspot.get_contact"].mockRejectedValue(new HubspotApiError(400, "bad request"));

    const result = await executeWorkflow("wf-1", { sleep: noopSleep });

    expect(toolExecutorMocks["hubspot.get_contact"]).toHaveBeenCalledTimes(1);
    expect(noopSleep).not.toHaveBeenCalled();
    expect(result.status).toBe("FAILED");
    expect(transitionMock).toHaveBeenCalledWith(
      "wf-1",
      "FAIL",
      { error: "HubSpot API error (400): bad request" },
      "executor",
    );
  });

  it("retries a retryable (5xx) failure with 1s/4s/16s backoff, then succeeds", async () => {
    workflowFindUniqueMock.mockResolvedValue(
      workflowRow({ plan: planWith([{ tool: "hubspot.get_contact", args: { contactId: "1" } }]) }),
    );
    toolExecutorMocks["hubspot.get_contact"]
      .mockRejectedValueOnce(new HubspotApiError(500, "server error"))
      .mockResolvedValueOnce({ ok: true });

    const result = await executeWorkflow("wf-1", { sleep: noopSleep });

    expect(toolExecutorMocks["hubspot.get_contact"]).toHaveBeenCalledTimes(2);
    expect(noopSleep).toHaveBeenCalledWith(1000);
    expect(result.status).toBe("DONE");
  });

  it("exhausts all 3 retries (4 total attempts) then fails, sleeping 1s/4s/16s", async () => {
    workflowFindUniqueMock.mockResolvedValue(
      workflowRow({ plan: planWith([{ tool: "hubspot.get_contact", args: { contactId: "1" } }]) }),
    );
    toolExecutorMocks["hubspot.get_contact"].mockRejectedValue(new HubspotApiError(503, "unavailable"));

    const result = await executeWorkflow("wf-1", { sleep: noopSleep });

    expect(toolExecutorMocks["hubspot.get_contact"]).toHaveBeenCalledTimes(4);
    expect(noopSleep.mock.calls.map((c) => c[0])).toEqual([1000, 4000, 16000]);
    expect(result.status).toBe("FAILED");
  });

  it("marks remaining steps skipped and sends a failure summary on halt", async () => {
    workflowFindUniqueMock.mockResolvedValue(
      workflowRow({
        plan: planWith([
          { tool: "hubspot.get_contact", args: { contactId: "1" } },
          { tool: "email.draft", args: { to: "a@example.com", subject: "s", body: "b" } },
        ]),
      }),
    );
    toolExecutorMocks["hubspot.get_contact"].mockRejectedValue(new HubspotApiError(400, "bad"));

    await executeWorkflow("wf-1", { sleep: noopSleep });

    expect(toolExecutorMocks["email.draft"]).not.toHaveBeenCalled();
    expect(workflowStepUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ stepIndex: 1, status: "skipped" }) }),
    );
    expect(sendFailureSummaryMock).toHaveBeenCalledWith("wf-1", "hubspot.get_contact", expect.any(String));
  });

  it("swallows a notifier failure during the failure-summary send", async () => {
    workflowFindUniqueMock.mockResolvedValue(
      workflowRow({ plan: planWith([{ tool: "hubspot.get_contact", args: { contactId: "1" } }]) }),
    );
    toolExecutorMocks["hubspot.get_contact"].mockRejectedValue(new HubspotApiError(400, "bad"));
    sendFailureSummaryMock.mockRejectedValue(new Error("telegram down"));

    const result = await executeWorkflow("wf-1", { sleep: noopSleep });
    expect(result.status).toBe("FAILED"); // did not throw
  });

  it("throws when the workflow doesn't exist", async () => {
    workflowFindUniqueMock.mockResolvedValue(null);
    await expect(executeWorkflow("missing")).rejects.toThrow("Workflow missing not found");
  });
});
