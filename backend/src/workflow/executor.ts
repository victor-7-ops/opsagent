import { getNotifier } from "../approval/notifier";
import { effectivePlan } from "../approval/editPlan";
import { HubspotApiError } from "../integrations/hubspot/client";
import { prisma } from "../db/client";
import { Plan, PlanSchema } from "../planner/plan";
import { writeAuditLog } from "./audit";
import { workflowEngine } from "./engine";
import { computeIdempotencyKey, runIdempotent } from "./idempotency";
import { ExecutionContext, resolveTemplatedArgs } from "./templating";
import { TOOL_EXECUTORS } from "./toolExecutors";

const RETRY_DELAYS_MS = [1000, 4000, 16000]; // SPEC.md §7: 3 retries, 1s/4s/16s backoff

function isRetryable(err: unknown): boolean {
  if (err instanceof HubspotApiError) return err.status >= 500;
  return true; // network-class errors (no HTTP status) — retryable by default
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

export interface ExecuteWorkflowResult {
  status: "DONE" | "FAILED" | "NOOP";
  results: ExecutionContext;
}

export interface ExecuteWorkflowOptions {
  sleep?: (ms: number) => Promise<void>;
}

async function markRemainingStepsSkipped(
  workflowId: string,
  plan: Plan,
  fromIndex: number,
): Promise<void> {
  for (let i = fromIndex; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const idempotencyKey = computeIdempotencyKey({
      workflowId,
      stepIndex: i,
      tool: step.tool,
      args: step.args,
    });
    await prisma.workflowStep.upsert({
      where: { workflowId_stepIndex: { workflowId, stepIndex: i } },
      create: {
        workflowId,
        stepIndex: i,
        tool: step.tool,
        args: step.args as object,
        idempotencyKey,
        status: "skipped",
      },
      update: { tool: step.tool, args: step.args as object, idempotencyKey, status: "skipped" },
    });
  }
}

// SPEC.md §7 — sequential execution in step_index order, idempotent
// (runIdempotent), retried with backoff on network/5xx only, halts on
// failure with remaining steps skipped + a notifier failure summary.
// Re-running on any workflow is a no-op for already-completed work: DONE/
// FAILED workflows return immediately, and already-succeeded steps are
// skipped by runIdempotent rather than re-executed.
export async function executeWorkflow(
  workflowId: string,
  options: ExecuteWorkflowOptions = {},
): Promise<ExecuteWorkflowResult> {
  const sleep = options.sleep ?? defaultSleep;

  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

  if (workflow.state === "DONE") return { status: "DONE", results: {} };
  if (workflow.state === "FAILED") return { status: "FAILED", results: {} };

  if (workflow.state === "APPROVED") {
    await workflowEngine.transition(workflowId, "START_EXECUTION", {}, "executor");
  } else if (workflow.state !== "EXECUTING") {
    throw new Error(`Cannot execute workflow ${workflowId} in state ${workflow.state}`);
  }

  const parseResult = PlanSchema.safeParse(workflow.plan);
  if (!parseResult.success) {
    throw new Error(`Workflow ${workflowId} has a plan that failed to parse: ${parseResult.error.message}`);
  }
  const plan = effectivePlan(parseResult.data);
  const context: ExecutionContext = {};

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const resolvedArgs = resolveTemplatedArgs(step.args, context);
    const idempotencyKey = computeIdempotencyKey({
      workflowId,
      stepIndex: i,
      tool: step.tool,
      args: resolvedArgs,
    });

    await writeAuditLog({
      workflowId,
      actor: "executor",
      event: "step_started",
      detail: { tool: step.tool, args: resolvedArgs, idempotencyKey },
    });

    try {
      const executeTool = TOOL_EXECUTORS[step.tool];
      if (!executeTool) throw new Error(`No executor registered for tool "${step.tool}"`);

      const { result } = await runIdempotent(
        { workflowId, stepIndex: i, tool: step.tool, args: resolvedArgs },
        () => withRetry(() => executeTool(resolvedArgs), sleep),
      );

      context[i] = result;
      await writeAuditLog({
        workflowId,
        actor: "executor",
        event: "step_executed",
        detail: { tool: step.tool, result },
      });
    } catch (err) {
      const message = (err as Error).message;
      await writeAuditLog({
        workflowId,
        actor: "executor",
        event: "step_failed",
        detail: { tool: step.tool, error: message },
      });

      await markRemainingStepsSkipped(workflowId, plan, i + 1);
      await workflowEngine.transition(workflowId, "FAIL", { error: message }, "executor");

      try {
        await getNotifier().sendFailureSummary(workflowId, step.tool, message);
      } catch {
        // Best-effort — a notifier outage must not mask the underlying step failure.
      }

      return { status: "FAILED", results: context };
    }
  }

  await workflowEngine.transition(workflowId, "COMPLETE", {}, "executor");
  return { status: "DONE", results: context };
}
