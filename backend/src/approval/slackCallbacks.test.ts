import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const { transitionMock, writeAuditLogMock } = vi.hoisted(() => ({
  transitionMock: vi.fn(),
  writeAuditLogMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../workflow/engine", () => ({ workflowEngine: { transition: transitionMock } }));
vi.mock("../workflow/audit", () => ({ writeAuditLog: writeAuditLogMock }));

import { handleSlackCallback } from "./slackCallbacks";

const SECRET = "test-signing-secret";

function sign(timestamp: string, rawBody: string): string {
  const baseString = `v0:${timestamp}:${rawBody}`;
  return "v0=" + crypto.createHmac("sha256", SECRET).update(baseString).digest("hex");
}

function makeReq(payloadObj: unknown, timestampOverride?: string): Request {
  const timestamp = timestampOverride ?? String(Math.floor(Date.now() / 1000));
  const rawBodyStr = `payload=${encodeURIComponent(JSON.stringify(payloadObj))}`;
  const signature = sign(timestamp, rawBodyStr);

  return {
    header: (name: string) => {
      if (name === "X-Slack-Request-Timestamp") return timestamp;
      if (name === "X-Slack-Signature") return signature;
      return undefined;
    },
    body: { payload: JSON.stringify(payloadObj) },
    rawBody: Buffer.from(rawBodyStr),
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
  res.send = vi.fn((body: unknown) => {
    res.body = body;
    return res as Response;
  }) as unknown as Response["send"];
  return res as Response & { statusCode?: number; body?: unknown };
}

function actionPayload(actionId: "approve" | "reject", workflowId: string, userId: string) {
  return { type: "block_actions", user: { id: userId }, actions: [{ action_id: actionId, value: workflowId }] };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("handleSlackCallback", () => {
  beforeEach(() => {
    transitionMock.mockReset();
    writeAuditLogMock.mockClear();
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.APPROVER_IDS = "U111,U222";
  });

  it("rejects with 401 for an invalid signature", async () => {
    const res = makeRes();
    const req = makeReq(actionPayload("approve", "wf-1", "U111"));
    // Tamper with the signature by using a request built for a different body.
    const badReq = { ...req, header: (name: string) => (name === "X-Slack-Signature" ? "v0=deadbeef" : req.header(name)) } as unknown as Request;

    await handleSlackCallback(badReq, res);
    expect(res.statusCode).toBe(401);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 for a stale timestamp", async () => {
    const res = makeRes();
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const req = makeReq(actionPayload("approve", "wf-1", "U111"), staleTimestamp);

    await handleSlackCallback(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("acks fast (200, empty body) once the signature is valid, before processing", async () => {
    transitionMock.mockResolvedValue({});
    const res = makeRes();
    await handleSlackCallback(makeReq(actionPayload("approve", "wf-1", "U111")), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
  });

  it("transitions APPROVED for an allowlisted approver clicking Approve", async () => {
    transitionMock.mockResolvedValue({});
    const res = makeRes();
    await handleSlackCallback(makeReq(actionPayload("approve", "wf-1", "U111")), res);
    await flush();

    expect(transitionMock).toHaveBeenCalledWith("wf-1", "APPROVE", { approvedBy: "U111" }, "approver:U111");
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "approval_decision", detail: { decision: "approved", by: "U111" } }),
    );
  });

  it("transitions REJECTED for an allowlisted approver clicking Reject", async () => {
    transitionMock.mockResolvedValue({});
    const res = makeRes();
    await handleSlackCallback(makeReq(actionPayload("reject", "wf-2", "U222")), res);
    await flush();

    expect(transitionMock).toHaveBeenCalledWith("wf-2", "REJECT", {}, "approver:U222");
  });

  it("ignores and audits a click from a non-allowlisted user without transitioning", async () => {
    const res = makeRes();
    await handleSlackCallback(makeReq(actionPayload("approve", "wf-3", "U999")), res);
    await flush();

    expect(transitionMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { decision: "unauthorized", by: "U999" } }),
    );
  });

  it("swallows an engine error without throwing", async () => {
    transitionMock.mockRejectedValue(new Error("illegal transition"));
    const res = makeRes();
    await expect(
      handleSlackCallback(makeReq(actionPayload("approve", "wf-4", "U111")), res),
    ).resolves.toBeUndefined();
    await flush();
  });
});
