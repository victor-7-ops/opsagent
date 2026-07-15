import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { getWorkflowStatsMock } = vi.hoisted(() => ({ getWorkflowStatsMock: vi.fn() }));
vi.mock("../workflow/stats", () => ({ getWorkflowStats: getWorkflowStatsMock }));

import statsRouter from "./stats";

function buildApp() {
  const app = express();
  app.use(statsRouter);
  return app;
}

describe("GET /stats", () => {
  beforeEach(() => {
    getWorkflowStatsMock.mockReset();
  });

  it("returns the computed stats as JSON", async () => {
    const stats = {
      workflowsByState: { DONE: 3 },
      approvalLatency: { averageSeconds: 42, medianSeconds: 42, sampleSize: 1 },
    };
    getWorkflowStatsMock.mockResolvedValue(stats);

    const res = await request(buildApp()).get("/stats");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(stats);
  });
});
