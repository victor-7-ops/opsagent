import { prisma } from "../db/client";
import { writeAuditLog } from "./audit";
import { workflowEngine } from "./engine";

const DEFAULT_TIMEOUT_HOURS = 24;

function getTimeoutHours(): number {
  const raw = process.env.APPROVAL_TIMEOUT_HOURS;
  const parsed = raw ? Number(raw) : DEFAULT_TIMEOUT_HOURS;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_HOURS;
}

export interface ExpirySweepResult {
  expired: string[];
  failed: { id: string; error: string }[];
}

// SPEC.md §4: AWAITING_APPROVAL -> EXPIRED after APPROVAL_TIMEOUT_HOURS
// (default 24h), swept every 15 min. A workflow's updatedAt reflects when it
// entered its current state (engine.transition always bumps it), so it also
// marks "time since entering AWAITING_APPROVAL" as long as no further
// transition has happened — which is exactly the case we're looking for.
export async function runExpirySweep(): Promise<ExpirySweepResult> {
  const cutoff = new Date(Date.now() - getTimeoutHours() * 60 * 60 * 1000);

  const candidates = await prisma.workflow.findMany({
    where: { state: "AWAITING_APPROVAL", updatedAt: { lt: cutoff } },
    select: { id: true },
  });

  const expired: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const { id } of candidates) {
    try {
      await workflowEngine.transition(id, "EXPIRE", {}, "scheduler");
      await writeAuditLog({
        workflowId: id,
        actor: "scheduler",
        event: "approval_decision",
        detail: { decision: "expired" },
      });
      expired.push(id);
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  return { expired, failed };
}
