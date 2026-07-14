import crypto from "crypto";
import { prisma } from "../db/client";

interface StepIdentity {
  workflowId: string;
  stepIndex: number;
  tool: string;
  args: Record<string, unknown>;
}

// idempotency_key = hash(workflow_id, step_index, tool, args) — SPEC.md §3/§7.
// Deterministic: same step identity always produces the same key, regardless
// of key order in `args`.
export function computeIdempotencyKey(step: StepIdentity): string {
  const canonicalArgs = JSON.stringify(step.args, Object.keys(step.args).sort());
  const source = `${step.workflowId}:${step.stepIndex}:${step.tool}:${canonicalArgs}`;
  return crypto.createHash("sha256").update(source).digest("hex");
}

export class MissingIdempotencyKeyError extends Error {
  constructor() {
    super("A step without an idempotency key must not run (CLAUDE.md hard constraint)");
    this.name = "MissingIdempotencyKeyError";
  }
}

interface IdempotentRunResult<T> {
  result: T;
  skipped: boolean;
}

// Wraps a single outbound (side-effecting) action with idempotency guarantees:
// - a `workflow_steps` row is the source of truth for whether this exact step
//   has already run
// - a step already `succeeded` is skipped and its stored result is returned —
//   re-running the executor on any workflow is always a no-op for completed steps
// - a step without a resolvable idempotency key never runs
export async function runIdempotent<T>(
  step: StepIdentity,
  action: () => Promise<T>,
): Promise<IdempotentRunResult<T>> {
  const idempotencyKey = computeIdempotencyKey(step);
  if (!idempotencyKey) throw new MissingIdempotencyKeyError();

  const existing = await prisma.workflowStep.findUnique({ where: { idempotencyKey } });

  if (existing?.status === "succeeded") {
    return { result: existing.result as T, skipped: true };
  }

  const row = await prisma.workflowStep.upsert({
    where: { idempotencyKey },
    create: {
      workflowId: step.workflowId,
      stepIndex: step.stepIndex,
      tool: step.tool,
      args: step.args as object,
      idempotencyKey,
      status: "running",
      attempts: 1,
    },
    update: {
      status: "running",
      attempts: { increment: 1 },
    },
  });

  try {
    const result = await action();
    await prisma.workflowStep.update({
      where: { id: row.id },
      data: { status: "succeeded", result: result as object, executedAt: new Date() },
    });
    return { result, skipped: false };
  } catch (err) {
    await prisma.workflowStep.update({
      where: { id: row.id },
      data: { status: "failed", result: { error: (err as Error).message } },
    });
    throw err;
  }
}
