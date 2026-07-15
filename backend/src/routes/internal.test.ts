import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { runExpirySweepMock } = vi.hoisted(() => ({
  runExpirySweepMock: vi.fn(),
}));

vi.mock("../workflow/expirySweep", () => ({ runExpirySweep: runExpirySweepMock }));

import internalRouter from "./internal";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(internalRouter);
  return app;
}

describe("POST /internal/workflows/expire-sweep", () => {
  beforeEach(() => {
    runExpirySweepMock.mockReset();
    process.env.INTERNAL_API_KEY = "test-internal-key";
  });

  it("rejects with 401 when the key header is missing", async () => {
    const res = await request(buildApp()).post("/internal/workflows/expire-sweep");
    expect(res.status).toBe(401);
    expect(runExpirySweepMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the key header is wrong", async () => {
    const res = await request(buildApp())
      .post("/internal/workflows/expire-sweep")
      .set("X-Internal-Api-Key", "wrong");
    expect(res.status).toBe(401);
  });

  it("runs the sweep and returns its result when the key matches", async () => {
    runExpirySweepMock.mockResolvedValue({ expired: ["wf-1"], failed: [] });
    const res = await request(buildApp())
      .post("/internal/workflows/expire-sweep")
      .set("X-Internal-Api-Key", "test-internal-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ expired: ["wf-1"], failed: [] });
    expect(runExpirySweepMock).toHaveBeenCalledTimes(1);
  });
});
