import { EventEmitter } from "events";
import { prisma } from "../db/client";
import { findTransition, WorkflowEvent, WorkflowState } from "./states";

export class IllegalTransitionError extends Error {
  constructor(workflowId: string, from: WorkflowState, event: WorkflowEvent) {
    super(`Illegal transition: workflow ${workflowId} in state ${from} cannot handle event ${event}`);
    this.name = "IllegalTransitionError";
  }
}

interface TransitionPayload {
  plan?: unknown;
  planSummary?: string;
  approvedBy?: string;
  notifierMessageRef?: string;
  error?: string;
}

interface TransitionEventDetail {
  workflowId: string;
  from: WorkflowState;
  to: WorkflowState;
  event: WorkflowEvent;
}

interface WorkflowRow {
  id: string;
  state: WorkflowState;
}

// State mutations must go through transition() only — this is the sole writer
// of workflows.state (per CLAUDE.md: direct `update workflows set state=...`
// anywhere else is a review-blocking violation).
export class WorkflowEngine extends EventEmitter {
  async transition(
    workflowId: string,
    event: WorkflowEvent,
    payload: TransitionPayload = {},
    actor = "engine",
  ) {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<WorkflowRow[]>`
        SELECT id, state FROM workflows WHERE id = ${workflowId}::uuid FOR UPDATE
      `;
      const current = rows[0];
      if (!current) throw new Error(`Workflow ${workflowId} not found`);

      const from = current.state;
      const transitionDef = findTransition(from, event);
      if (!transitionDef) throw new IllegalTransitionError(workflowId, from, event);

      const to = transitionDef.to;

      const updated = await tx.workflow.update({
        where: { id: workflowId },
        data: {
          state: to,
          updatedAt: new Date(),
          ...(payload.plan !== undefined ? { plan: payload.plan as object } : {}),
          ...(payload.planSummary !== undefined ? { planSummary: payload.planSummary } : {}),
          ...(payload.approvedBy !== undefined ? { approvedBy: payload.approvedBy } : {}),
          ...(payload.notifierMessageRef !== undefined
            ? { notifierMessageRef: payload.notifierMessageRef }
            : {}),
          ...(payload.error !== undefined ? { error: payload.error } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          workflowId,
          actor,
          event: "state_transition",
          detail: { from, to, event } as object,
        },
      });

      const detail: TransitionEventDetail = { workflowId, from, to, event };
      this.emit("transition", detail);

      return updated;
    });
  }
}

export const workflowEngine = new WorkflowEngine();
