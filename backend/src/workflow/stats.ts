import { prisma } from "../db/client";

interface StateTransitionRow {
  workflow_id: string;
  to_state: string;
  created_at: Date;
}

export interface WorkflowStats {
  workflowsByState: Record<string, number>;
  approvalLatency: { averageSeconds: number | null; medianSeconds: number | null; sampleSize: number };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// SPEC.md §9 explicitly caps this milestone's reporting at "a simple stats
// endpoint (GET /stats)" — a full UI dashboard is a non-goal for v2.0.
export async function getWorkflowStats(): Promise<WorkflowStats> {
  const grouped = await prisma.workflow.groupBy({ by: ["state"], _count: { state: true } });
  const workflowsByState: Record<string, number> = {};
  for (const g of grouped) workflowsByState[g.state] = g._count.state;

  // Approval latency isn't a stored column — derive it from the audit trail's
  // AWAITING_APPROVAL -> APPROVED state_transition timestamps per workflow.
  const rows = await prisma.$queryRaw<StateTransitionRow[]>`
    SELECT workflow_id, detail->>'to' as to_state, created_at
    FROM audit_log
    WHERE event = 'state_transition' AND detail->>'to' IN ('AWAITING_APPROVAL', 'APPROVED')
    ORDER BY workflow_id, created_at
  `;

  const byWorkflow = new Map<string, StateTransitionRow[]>();
  for (const row of rows) {
    const list = byWorkflow.get(row.workflow_id) ?? [];
    list.push(row);
    byWorkflow.set(row.workflow_id, list);
  }

  const latenciesSeconds: number[] = [];
  for (const events of byWorkflow.values()) {
    const awaiting = events.find((e) => e.to_state === "AWAITING_APPROVAL");
    const approved = events.find(
      (e) => e.to_state === "APPROVED" && awaiting && e.created_at > awaiting.created_at,
    );
    if (awaiting && approved) {
      latenciesSeconds.push((approved.created_at.getTime() - awaiting.created_at.getTime()) / 1000);
    }
  }

  return {
    workflowsByState,
    approvalLatency: {
      averageSeconds: latenciesSeconds.length
        ? latenciesSeconds.reduce((a, b) => a + b, 0) / latenciesSeconds.length
        : null,
      medianSeconds: latenciesSeconds.length ? median(latenciesSeconds) : null,
      sampleSize: latenciesSeconds.length,
    },
  };
}
