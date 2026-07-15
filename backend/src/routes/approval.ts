import { Router } from "express";
import { prisma } from "../db/client";
import { writeAuditLog } from "../workflow/audit";
import { PlanSchema } from "../planner/plan";
import { editPlanStep, StepIndexOutOfRangeError } from "../approval/editPlan";

const router = Router();

function verifyInternalKey(header: string | undefined): boolean {
  const expected = process.env.INTERNAL_API_KEY;
  return Boolean(expected) && header === expected;
}

function getApproverAllowlist(): Set<string> {
  const raw = process.env.APPROVER_IDS || "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

// SPEC.md §6 — "stretch" plan-editing feature (Issue 14), implemented:
// an allowlisted approver can override a single step's args before
// approving. Only valid while the workflow is still AWAITING_APPROVAL; the
// edit is re-validated against the effective plan before it's persisted.
router.post("/approval/:workflowId/edit-step", async (req, res) => {
  if (!verifyInternalKey(req.header("X-Internal-Api-Key"))) {
    res.status(401).json({ error: "Invalid or missing X-Internal-Api-Key" });
    return;
  }

  const { workflowId } = req.params;
  const { approverId, stepIndex, args } = req.body as {
    approverId?: string;
    stepIndex?: number;
    args?: Record<string, unknown>;
  };

  if (typeof approverId !== "string" || typeof stepIndex !== "number" || typeof args !== "object" || args === null) {
    res.status(400).json({ error: "Expected { approverId: string, stepIndex: number, args: object }" });
    return;
  }

  if (!getApproverAllowlist().has(approverId)) {
    res.status(403).json({ error: "Approver is not on the allowlist" });
    return;
  }

  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!workflow) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }

  if (workflow.state !== "AWAITING_APPROVAL") {
    res.status(409).json({ error: `Cannot edit a plan in state ${workflow.state}` });
    return;
  }

  const currentPlan = PlanSchema.safeParse(workflow.plan);
  if (!currentPlan.success) {
    res.status(500).json({ error: "Stored plan failed to parse" });
    return;
  }

  let result;
  try {
    result = editPlanStep(currentPlan.data, stepIndex, args, workflow.triggerPayload);
  } catch (err) {
    if (err instanceof StepIndexOutOfRangeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  if (!result.validation.valid) {
    res.status(400).json({ error: "Edit produces an invalid plan", reasons: result.validation.reasons });
    return;
  }

  await prisma.workflow.update({
    where: { id: workflowId },
    data: { plan: result.plan as object, updatedAt: new Date() },
  });

  await writeAuditLog({
    workflowId,
    actor: `approver:${approverId}`,
    event: "plan_edited",
    detail: { stepIndex, args, by: approverId },
  });

  res.status(200).json({ plan: result.plan });
});

export default router;
