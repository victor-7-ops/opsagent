import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db/client";
import { WorkflowEvent, WorkflowState } from "./states";

// Either the real client or a $transaction callback's tx — lets writers
// participate in an in-flight transaction (e.g. engine.transition) or write
// standalone (planner, approval).
type AuditWritable = PrismaClient | Prisma.TransactionClient;

type AuditEvent =
  | { event: "state_transition"; detail: { from: WorkflowState; to: WorkflowState; event: WorkflowEvent } }
  | { event: "plan_created"; detail: { plan: unknown } }
  | { event: "plan_rejected"; detail: { reason: string } }
  | {
      event: "approval_decision";
      detail: { decision: "approved" | "rejected" | "expired" | "unauthorized"; by?: string; reason?: string };
    }
  | { event: "step_started"; detail: { tool: string; args: Record<string, unknown>; idempotencyKey: string } }
  | { event: "step_executed"; detail: { tool: string; result: unknown } }
  | { event: "step_failed"; detail: { tool: string; error: string } };

interface WriteAuditLogArgs {
  workflowId: string | null;
  actor: string;
  client?: AuditWritable;
}

// Single entry point for audit_log writes — structured, typed per event kind
// (no ad-hoc `detail` shapes scattered across modules). Every transition,
// plan creation, approval decision, and step execution should go through
// this (CLAUDE.md).
export async function writeAuditLog(
  args: WriteAuditLogArgs & AuditEvent,
): Promise<void> {
  const client = args.client ?? prisma;
  await client.auditLog.create({
    data: {
      workflowId: args.workflowId,
      actor: args.actor,
      event: args.event,
      detail: args.detail as object,
    },
  });
}
