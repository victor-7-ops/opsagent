import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSITIONS, WorkflowState } from "./states";

// vi.mock is hoisted above all imports/consts by vitest, so anything it
// references must itself be created inside vi.hoisted() to avoid a TDZ error.
const { txMock, prismaMock } = vi.hoisted(() => {
  const txMock = {
    $queryRaw: vi.fn(),
    workflow: { update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const prismaMock = {
    $transaction: vi.fn(async (cb: (tx: typeof txMock) => unknown) => cb(txMock)),
  };
  return { txMock, prismaMock };
});

vi.mock("../db/client", () => ({ prisma: prismaMock }));

import { WorkflowEngine, IllegalTransitionError } from "./engine";

function setCurrentState(state: WorkflowState) {
  txMock.$queryRaw.mockResolvedValue([{ id: "wf-1", state }]);
  txMock.workflow.update.mockResolvedValue({ id: "wf-1", state });
}

describe("WorkflowEngine.transition", () => {
  beforeEach(() => {
    txMock.$queryRaw.mockReset();
    txMock.workflow.update.mockReset();
    txMock.auditLog.create.mockReset();
    prismaMock.$transaction.mockClear();
  });

  it("applies every legal transition: updates state, writes audit_log, emits event", async () => {
    for (const t of TRANSITIONS) {
      setCurrentState(t.from);
      const engine = new WorkflowEngine();
      const emitted: unknown[] = [];
      engine.on("transition", (d) => emitted.push(d));

      await engine.transition("wf-1", t.event);

      expect(txMock.workflow.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "wf-1" },
          data: expect.objectContaining({ state: t.to }),
        }),
      );
      expect(txMock.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workflowId: "wf-1",
            event: "state_transition",
            detail: { from: t.from, to: t.to, event: t.event },
          }),
        }),
      );
      expect(emitted).toEqual([{ workflowId: "wf-1", from: t.from, to: t.to, event: t.event }]);
    }
  });

  it("rejects an illegal transition without mutating state or writing audit_log", async () => {
    setCurrentState("TRIAGED");
    const engine = new WorkflowEngine();

    await expect(engine.transition("wf-1", "START_EXECUTION")).rejects.toThrow(
      IllegalTransitionError,
    );
    expect(txMock.workflow.update).not.toHaveBeenCalled();
    expect(txMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects every illegal (state, event) combination", async () => {
    const legalPairs = new Set(TRANSITIONS.map((t) => `${t.from}:${t.event}`));
    const allStates = Array.from(new Set(TRANSITIONS.flatMap((t) => [t.from, t.to])));
    const allEvents = Array.from(new Set(TRANSITIONS.map((t) => t.event)));

    for (const state of allStates) {
      for (const event of allEvents) {
        if (legalPairs.has(`${state}:${event}`)) continue;

        setCurrentState(state);
        const engine = new WorkflowEngine();
        await expect(engine.transition("wf-1", event)).rejects.toThrow(IllegalTransitionError);
      }
    }
  });

  it("throws if the workflow does not exist", async () => {
    txMock.$queryRaw.mockResolvedValue([]);
    const engine = new WorkflowEngine();

    await expect(engine.transition("missing", "CREATE_PLAN")).rejects.toThrow(
      "Workflow missing not found",
    );
  });
});
