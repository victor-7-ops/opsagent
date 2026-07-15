import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, transitionMock, writeAuditLogMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  transitionMock: vi.fn(),
  writeAuditLogMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/client", () => ({ prisma: { workflow: { findMany: findManyMock } } }));
vi.mock("./engine", () => ({ workflowEngine: { transition: transitionMock } }));
vi.mock("./audit", () => ({ writeAuditLog: writeAuditLogMock }));

import { runExpirySweep } from "./expirySweep";

describe("runExpirySweep", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    transitionMock.mockReset();
    writeAuditLogMock.mockClear();
    delete process.env.APPROVAL_TIMEOUT_HOURS;
  });

  it("queries AWAITING_APPROVAL workflows older than the timeout cutoff", async () => {
    findManyMock.mockResolvedValue([]);
    const before = Date.now();

    await runExpirySweep();

    const args = findManyMock.mock.calls[0][0];
    expect(args.where.state).toBe("AWAITING_APPROVAL");
    const cutoffMs = args.where.updatedAt.lt.getTime();
    const expectedCutoffMs = before - 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - expectedCutoffMs)).toBeLessThan(5000);
  });

  it("respects a custom APPROVAL_TIMEOUT_HOURS", async () => {
    process.env.APPROVAL_TIMEOUT_HOURS = "1";
    findManyMock.mockResolvedValue([]);
    const before = Date.now();

    await runExpirySweep();

    const cutoffMs = findManyMock.mock.calls[0][0].where.updatedAt.lt.getTime();
    expect(Math.abs(cutoffMs - (before - 60 * 60 * 1000))).toBeLessThan(5000);
  });

  it("transitions each candidate to EXPIRE and writes an approval_decision audit entry", async () => {
    findManyMock.mockResolvedValue([{ id: "wf-1" }, { id: "wf-2" }]);
    transitionMock.mockResolvedValue({});

    const result = await runExpirySweep();

    expect(transitionMock).toHaveBeenCalledWith("wf-1", "EXPIRE", {}, "scheduler");
    expect(transitionMock).toHaveBeenCalledWith("wf-2", "EXPIRE", {}, "scheduler");
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
        event: "approval_decision",
        detail: { decision: "expired" },
      }),
    );
    expect(result).toEqual({ expired: ["wf-1", "wf-2"], failed: [] });
  });

  it("collects per-workflow failures without aborting the whole sweep", async () => {
    findManyMock.mockResolvedValue([{ id: "wf-1" }, { id: "wf-2" }]);
    transitionMock.mockRejectedValueOnce(new Error("already decided")).mockResolvedValueOnce({});

    const result = await runExpirySweep();

    expect(result.expired).toEqual(["wf-2"]);
    expect(result.failed).toEqual([{ id: "wf-1", error: "already decided" }]);
  });
});
