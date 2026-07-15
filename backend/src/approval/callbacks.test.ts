import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const { transitionMock, writeAuditLogMock } = vi.hoisted(() => ({
  transitionMock: vi.fn(),
  writeAuditLogMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../workflow/engine", () => ({ workflowEngine: { transition: transitionMock } }));
vi.mock("../workflow/audit", () => ({ writeAuditLog: writeAuditLogMock }));

import { handleTelegramCallback } from "./callbacks";

const SECRET = "test-secret";

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name],
    body,
  } as unknown as Request;
}

function makeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res as Response;
  }) as unknown as Response["json"];
  return res as Response & { statusCode?: number; body?: unknown };
}

function approvalUpdate(action: "approve" | "reject", workflowId: string, userId: number) {
  return {
    update_id: 1,
    callback_query: {
      id: "cb-1",
      from: { id: userId },
      data: `${action}:${workflowId}`,
    },
  };
}

// Let any fire-and-forget async work inside the handler settle before assertions.
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("handleTelegramCallback", () => {
  beforeEach(() => {
    transitionMock.mockReset();
    writeAuditLogMock.mockClear();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    process.env.APPROVER_IDS = "111,222";
  });

  it("rejects with 401 when the secret token header is missing or wrong", async () => {
    const res = makeRes();
    await handleTelegramCallback(makeReq({}, {}), res);
    expect(res.statusCode).toBe(401);
    expect(transitionMock).not.toHaveBeenCalled();

    const res2 = makeRes();
    await handleTelegramCallback(makeReq({}, { "X-Telegram-Bot-Api-Secret-Token": "wrong" }), res2);
    expect(res2.statusCode).toBe(401);
  });

  it("always acks 200 once the secret is valid, even for a malformed update", async () => {
    const res = makeRes();
    await handleTelegramCallback(makeReq({}, { "X-Telegram-Bot-Api-Secret-Token": SECRET }), res);
    expect(res.statusCode).toBe(200);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("transitions to APPROVED and writes an approval_decision entry for an allowlisted approver", async () => {
    transitionMock.mockResolvedValue({});
    const res = makeRes();
    await handleTelegramCallback(
      makeReq(approvalUpdate("approve", "wf-1", 111), { "X-Telegram-Bot-Api-Secret-Token": SECRET }),
      res,
    );
    await flush();

    expect(res.statusCode).toBe(200);
    expect(transitionMock).toHaveBeenCalledWith(
      "wf-1",
      "APPROVE",
      { approvedBy: "111" },
      "approver:111",
    );
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
        event: "approval_decision",
        detail: { decision: "approved", by: "111" },
      }),
    );
  });

  it("transitions to REJECTED for an allowlisted approver", async () => {
    transitionMock.mockResolvedValue({});
    const res = makeRes();
    await handleTelegramCallback(
      makeReq(approvalUpdate("reject", "wf-2", 222), { "X-Telegram-Bot-Api-Secret-Token": SECRET }),
      res,
    );
    await flush();

    expect(transitionMock).toHaveBeenCalledWith("wf-2", "REJECT", {}, "approver:222");
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { decision: "rejected", by: "222" } }),
    );
  });

  it("ignores and audits a click from a non-allowlisted user without transitioning", async () => {
    const res = makeRes();
    await handleTelegramCallback(
      makeReq(approvalUpdate("approve", "wf-3", 999), { "X-Telegram-Bot-Api-Secret-Token": SECRET }),
      res,
    );
    await flush();

    expect(transitionMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-3",
        event: "approval_decision",
        detail: { decision: "unauthorized", by: "999" },
      }),
    );
  });

  it("swallows an illegal-transition error from the engine without throwing", async () => {
    transitionMock.mockRejectedValue(new Error("Illegal transition"));
    const res = makeRes();
    await expect(
      handleTelegramCallback(
        makeReq(approvalUpdate("approve", "wf-4", 111), { "X-Telegram-Bot-Api-Secret-Token": SECRET }),
        res,
      ),
    ).resolves.toBeUndefined();
    await flush();

    expect(res.statusCode).toBe(200);
  });

  it("ignores callback_data that doesn't match the approve/reject pattern", async () => {
    const res = makeRes();
    await handleTelegramCallback(
      makeReq(
        { update_id: 1, callback_query: { id: "cb", from: { id: 111 }, data: "garbage" } },
        { "X-Telegram-Bot-Api-Secret-Token": SECRET },
      ),
      res,
    );
    await flush();

    expect(transitionMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });
});
