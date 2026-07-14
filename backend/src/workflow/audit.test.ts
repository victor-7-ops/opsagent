import { describe, expect, it, vi } from "vitest";
import { writeAuditLog } from "./audit";

function makeClientMock() {
  return { auditLog: { create: vi.fn().mockResolvedValue({}) } };
}

describe("writeAuditLog", () => {
  it("writes a state_transition event with the given workflowId/actor", async () => {
    const client = makeClientMock();
    await writeAuditLog({
      workflowId: "wf-1",
      actor: "engine",
      client: client as never,
      event: "state_transition",
      detail: { from: "TRIAGED", to: "PLANNED", event: "CREATE_PLAN" },
    });

    expect(client.auditLog.create).toHaveBeenCalledWith({
      data: {
        workflowId: "wf-1",
        actor: "engine",
        event: "state_transition",
        detail: { from: "TRIAGED", to: "PLANNED", event: "CREATE_PLAN" },
      },
    });
  });

  it("writes an approval_decision event with optional fields", async () => {
    const client = makeClientMock();
    await writeAuditLog({
      workflowId: "wf-2",
      actor: "approver:victor",
      client: client as never,
      event: "approval_decision",
      detail: { decision: "rejected", by: "victor", reason: "wrong deal" },
    });

    expect(client.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: "approval_decision",
        detail: { decision: "rejected", by: "victor", reason: "wrong deal" },
      }),
    });
  });

  it("allows a null workflowId (e.g. a rejected callback with no resolvable workflow)", async () => {
    const client = makeClientMock();
    await writeAuditLog({
      workflowId: null,
      actor: "callback",
      client: client as never,
      event: "step_failed",
      detail: { tool: "email.send", error: "boom" },
    });

    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workflowId: null }) }),
    );
  });
});
