import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Plan } from "../planner/plan";

const { findUniqueMock, updateMock, writeAuditLogMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
  writeAuditLogMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/client", () => ({
  prisma: { workflow: { findUnique: findUniqueMock, update: updateMock } },
}));
vi.mock("../workflow/audit", () => ({ writeAuditLog: writeAuditLogMock }));

import approvalRouter from "./approval";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(approvalRouter);
  return app;
}

const SAMPLE_PLAN: Plan = {
  goal: "Route lead",
  risk_level: "low",
  steps: [
    { tool: "hubspot.get_contact", args: { contactId: "1" }, rationale: "read", depends_on: [] },
    {
      tool: "email.draft",
      args: { to: "old@example.com", subject: "hi", body: "hello" },
      rationale: "draft",
      depends_on: [0],
    },
  ],
  human_summary: "Look up the lead and draft a reply.",
};

function workflowRow(overrides: Partial<{ state: string; plan: unknown; triggerPayload: unknown }> = {}) {
  return {
    id: "wf-1",
    state: "AWAITING_APPROVAL",
    plan: SAMPLE_PLAN,
    triggerPayload: { contactId: "1" },
    ...overrides,
  };
}

describe("POST /approval/:workflowId/edit-step", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    updateMock.mockClear();
    writeAuditLogMock.mockClear();
    process.env.INTERNAL_API_KEY = "test-internal-key";
    process.env.APPROVER_IDS = "approver-1";
  });

  const KEY = { "X-Internal-Api-Key": "test-internal-key" };

  it("rejects with 401 when the internal key is missing", async () => {
    const res = await request(buildApp()).post("/approval/wf-1/edit-step").send({});
    expect(res.status).toBe(401);
  });

  it("rejects with 400 for a malformed body", async () => {
    const res = await request(buildApp()).post("/approval/wf-1/edit-step").set(KEY).send({});
    expect(res.status).toBe(400);
  });

  it("rejects with 403 for a non-allowlisted approver", async () => {
    const res = await request(buildApp())
      .post("/approval/wf-1/edit-step")
      .set(KEY)
      .send({ approverId: "not-allowed", stepIndex: 1, args: { to: "a@example.com" } });
    expect(res.status).toBe(403);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("rejects with 404 when the workflow doesn't exist", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await request(buildApp())
      .post("/approval/wf-1/edit-step")
      .set(KEY)
      .send({ approverId: "approver-1", stepIndex: 1, args: {} });
    expect(res.status).toBe(404);
  });

  it("rejects with 409 when the workflow isn't AWAITING_APPROVAL", async () => {
    findUniqueMock.mockResolvedValue(workflowRow({ state: "DONE" }));
    const res = await request(buildApp())
      .post("/approval/wf-1/edit-step")
      .set(KEY)
      .send({ approverId: "approver-1", stepIndex: 1, args: {} });
    expect(res.status).toBe(409);
  });

  it("rejects with 400 when the edit produces an invalid plan", async () => {
    findUniqueMock.mockResolvedValue(workflowRow());
    const res = await request(buildApp())
      .post("/approval/wf-1/edit-step")
      .set(KEY)
      .send({ approverId: "approver-1", stepIndex: 1, args: { to: "not-an-email", subject: "hi", body: "x" } });

    expect(res.status).toBe(400);
    expect(res.body.reasons).toBeDefined();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("persists a valid edit and writes a plan_edited audit entry", async () => {
    findUniqueMock.mockResolvedValue(workflowRow());
    const res = await request(buildApp())
      .post("/approval/wf-1/edit-step")
      .set(KEY)
      .send({ approverId: "approver-1", stepIndex: 1, args: { to: "new@example.com", subject: "hi", body: "hello" } });

    expect(res.status).toBe(200);
    expect(res.body.plan.steps[1].edited_args).toEqual({
      to: "new@example.com",
      subject: "hi",
      body: "hello",
    });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "wf-1" } }),
    );
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
        event: "plan_edited",
        detail: expect.objectContaining({ stepIndex: 1, by: "approver-1" }),
      }),
    );
  });
});
