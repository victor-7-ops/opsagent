import crypto from "crypto";
import { Request, Response } from "express";
import { writeAuditLog } from "../workflow/audit";
import { workflowEngine } from "../workflow/engine";

const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

function getApproverAllowlist(): Set<string> {
  const raw = process.env.APPROVER_IDS || "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

// Slack signs the raw body: v0:{timestamp}:{body}, HMAC-SHA256 with the
// signing secret, hex-encoded, prefixed "v0=" (CLAUDE.md hard constraint:
// verify Slack signatures on all callback endpoints).
function verifySlackSignature(req: Request): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const timestamp = req.header("X-Slack-Request-Timestamp");
  const signature = req.header("X-Slack-Signature");
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!signingSecret || !timestamp || !signature || !rawBody) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const expected =
    "v0=" + crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex");

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

interface SlackInteractionPayload {
  type: string;
  user: { id: string };
  actions?: { action_id: string; value: string }[];
}

// SPEC.md §6 — mirrors handleTelegramCallback (Issue 12): allowlisted
// approve/reject transitions the workflow, non-allowlisted clicks are
// ignored + audited, failures are swallowed after a fast ack.
export async function handleSlackCallback(req: Request, res: Response): Promise<void> {
  if (!verifySlackSignature(req)) {
    res.status(401).json({ error: "Invalid or missing Slack signature" });
    return;
  }

  // Slack expects a fast ack (empty 200 dismisses the button's loading state).
  res.status(200).send("");

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse((req.body as { payload: string }).payload);
  } catch {
    return;
  }

  const action = payload.actions?.[0];
  if (!action || (action.action_id !== "approve" && action.action_id !== "reject")) return;

  const workflowId = action.value;
  const approverId = payload.user.id;

  if (!getApproverAllowlist().has(approverId)) {
    await writeAuditLog({
      workflowId,
      actor: `slack:${approverId}`,
      event: "approval_decision",
      detail: { decision: "unauthorized", by: approverId },
    });
    return;
  }

  const actor = `approver:${approverId}`;

  try {
    if (action.action_id === "approve") {
      await workflowEngine.transition(workflowId, "APPROVE", { approvedBy: approverId }, actor);
      await writeAuditLog({
        workflowId,
        actor,
        event: "approval_decision",
        detail: { decision: "approved", by: approverId },
      });
    } else {
      await workflowEngine.transition(workflowId, "REJECT", {}, actor);
      await writeAuditLog({
        workflowId,
        actor,
        event: "approval_decision",
        detail: { decision: "rejected", by: approverId },
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Slack callback for workflow ${workflowId} failed: ${(err as Error).message}`);
  }
}
