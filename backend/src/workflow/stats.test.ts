import { beforeEach, describe, expect, it, vi } from "vitest";

const { groupByMock, queryRawMock } = vi.hoisted(() => ({
  groupByMock: vi.fn(),
  queryRawMock: vi.fn(),
}));

vi.mock("../db/client", () => ({
  prisma: { workflow: { groupBy: groupByMock }, $queryRaw: queryRawMock },
}));

import { getWorkflowStats } from "./stats";

function transition(workflowId: string, toState: string, isoTime: string) {
  return { workflow_id: workflowId, to_state: toState, created_at: new Date(isoTime) };
}

describe("getWorkflowStats", () => {
  beforeEach(() => {
    groupByMock.mockReset();
    queryRawMock.mockReset();
  });

  it("returns workflow counts keyed by state", async () => {
    groupByMock.mockResolvedValue([
      { state: "DONE", _count: { state: 5 } },
      { state: "AWAITING_APPROVAL", _count: { state: 2 } },
    ]);
    queryRawMock.mockResolvedValue([]);

    const stats = await getWorkflowStats();
    expect(stats.workflowsByState).toEqual({ DONE: 5, AWAITING_APPROVAL: 2 });
  });

  it("returns null latency stats and zero sample size when there's no data", async () => {
    groupByMock.mockResolvedValue([]);
    queryRawMock.mockResolvedValue([]);

    const stats = await getWorkflowStats();
    expect(stats.approvalLatency).toEqual({ averageSeconds: null, medianSeconds: null, sampleSize: 0 });
  });

  it("computes latency as the gap between AWAITING_APPROVAL and APPROVED per workflow", async () => {
    groupByMock.mockResolvedValue([]);
    queryRawMock.mockResolvedValue([
      transition("wf-1", "AWAITING_APPROVAL", "2026-01-01T00:00:00Z"),
      transition("wf-1", "APPROVED", "2026-01-01T00:01:40Z"), // +100s
    ]);

    const stats = await getWorkflowStats();
    expect(stats.approvalLatency).toEqual({ averageSeconds: 100, medianSeconds: 100, sampleSize: 1 });
  });

  it("averages and medians across multiple workflows", async () => {
    groupByMock.mockResolvedValue([]);
    queryRawMock.mockResolvedValue([
      transition("wf-1", "AWAITING_APPROVAL", "2026-01-01T00:00:00Z"),
      transition("wf-1", "APPROVED", "2026-01-01T00:00:10Z"), // 10s
      transition("wf-2", "AWAITING_APPROVAL", "2026-01-01T00:00:00Z"),
      transition("wf-2", "APPROVED", "2026-01-01T00:00:20Z"), // 20s
      transition("wf-3", "AWAITING_APPROVAL", "2026-01-01T00:00:00Z"),
      transition("wf-3", "APPROVED", "2026-01-01T00:00:30Z"), // 30s
    ]);

    const stats = await getWorkflowStats();
    expect(stats.approvalLatency).toEqual({ averageSeconds: 20, medianSeconds: 20, sampleSize: 3 });
  });

  it("excludes a workflow that never reached APPROVED (only AWAITING_APPROVAL)", async () => {
    groupByMock.mockResolvedValue([]);
    queryRawMock.mockResolvedValue([transition("wf-1", "AWAITING_APPROVAL", "2026-01-01T00:00:00Z")]);

    const stats = await getWorkflowStats();
    expect(stats.approvalLatency.sampleSize).toBe(0);
  });

  it("ignores an APPROVED event that precedes AWAITING_APPROVAL (stale/out-of-order data)", async () => {
    groupByMock.mockResolvedValue([]);
    queryRawMock.mockResolvedValue([
      transition("wf-1", "APPROVED", "2025-12-31T23:59:00Z"),
      transition("wf-1", "AWAITING_APPROVAL", "2026-01-01T00:00:00Z"),
    ]);

    const stats = await getWorkflowStats();
    expect(stats.approvalLatency.sampleSize).toBe(0);
  });
});
