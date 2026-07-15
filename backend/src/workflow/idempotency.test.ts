import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUniqueMock, upsertMock, updateMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  upsertMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
}));

vi.mock("../db/client", () => ({
  prisma: { workflowStep: { findUnique: findUniqueMock, upsert: upsertMock, update: updateMock } },
}));

import { computeIdempotencyKey, runIdempotent } from "./idempotency";

const STEP = { workflowId: "wf-1", stepIndex: 0, tool: "hubspot.get_contact", args: { contactId: "1" } };

describe("computeIdempotencyKey", () => {
  it("is stable regardless of key order in args", () => {
    const a = computeIdempotencyKey({ ...STEP, args: { to: "x", subject: "y" } });
    const b = computeIdempotencyKey({ ...STEP, args: { subject: "y", to: "x" } });
    expect(a).toBe(b);
  });

  it("differs when args actually differ", () => {
    const a = computeIdempotencyKey({ ...STEP, args: { contactId: "1" } });
    const b = computeIdempotencyKey({ ...STEP, args: { contactId: "2" } });
    expect(a).not.toBe(b);
  });

  it("differs across different step slots even with identical args", () => {
    const a = computeIdempotencyKey({ ...STEP, stepIndex: 0 });
    const b = computeIdempotencyKey({ ...STEP, stepIndex: 1 });
    expect(a).not.toBe(b);
  });
});

describe("runIdempotent", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    upsertMock.mockReset();
    updateMock.mockClear();
  });

  it("looks up and upserts by the (workflowId, stepIndex) slot, not idempotencyKey alone", async () => {
    findUniqueMock.mockResolvedValue(undefined);
    upsertMock.mockResolvedValue({ id: "ws-1" });

    await runIdempotent(STEP, async () => ({ ok: true }));

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { workflowId_stepIndex: { workflowId: "wf-1", stepIndex: 0 } },
    });
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workflowId_stepIndex: { workflowId: "wf-1", stepIndex: 0 } },
      }),
    );
  });

  it("runs the action and marks the row succeeded on first attempt", async () => {
    findUniqueMock.mockResolvedValue(undefined);
    upsertMock.mockResolvedValue({ id: "ws-1" });

    const result = await runIdempotent(STEP, async () => ({ ok: true }));

    expect(result).toEqual({ result: { ok: true }, skipped: false });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ws-1" }, data: expect.objectContaining({ status: "succeeded" }) }),
    );
  });

  it("skips re-running when the slot already succeeded under the SAME idempotencyKey", async () => {
    const key = computeIdempotencyKey(STEP);
    findUniqueMock.mockResolvedValue({ status: "succeeded", idempotencyKey: key, result: { cached: true } });

    const action = vi.fn();
    const result = await runIdempotent(STEP, action);

    expect(action).not.toHaveBeenCalled();
    expect(result).toEqual({ result: { cached: true }, skipped: true });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  // Regression test: previously, upserting by idempotencyKey alone crashed
  // with a unique-constraint violation on (workflowId, stepIndex) when a
  // slot's args (and thus idempotencyKey) changed between attempts — e.g.
  // a step marked "skipped" during an earlier halt, then genuinely resolved
  // and attempted on resume. Caught via live testing against real Postgres.
  it("re-runs (does not skip) when the slot's stored idempotencyKey differs from the current one", async () => {
    findUniqueMock.mockResolvedValue({
      status: "succeeded",
      idempotencyKey: "a-different-key-from-a-prior-attempt",
      result: { stale: true },
    });
    upsertMock.mockResolvedValue({ id: "ws-1" });

    const action = vi.fn().mockResolvedValue({ fresh: true });
    const result = await runIdempotent(STEP, action);

    expect(action).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ result: { fresh: true }, skipped: false });
  });

  it("marks the row failed and rethrows when the action throws", async () => {
    findUniqueMock.mockResolvedValue(undefined);
    upsertMock.mockResolvedValue({ id: "ws-1" });

    await expect(runIdempotent(STEP, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ws-1" },
        data: expect.objectContaining({ status: "failed", result: { error: "boom" } }),
      }),
    );
  });

  it("a retry after failure re-runs and can succeed", async () => {
    findUniqueMock.mockResolvedValue({ status: "failed", idempotencyKey: computeIdempotencyKey(STEP) });
    upsertMock.mockResolvedValue({ id: "ws-1" });

    const result = await runIdempotent(STEP, async () => ({ ok: true }));
    expect(result).toEqual({ result: { ok: true }, skipped: false });
  });
});
