import { Request, Response } from "express";
import { writeAuditLog } from "../workflow/audit";
import { workflowEngine } from "../workflow/engine";

interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
}

const CALLBACK_DATA_PATTERN = /^(approve|reject):(.+)$/;

function getApproverAllowlist(): Set<string> {
  const raw = process.env.APPROVER_IDS || "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

// Telegram doesn't sign webhook bodies — it echoes a secret_token (set via
// setWebhook) back on every request header instead (CLAUDE.md hard
// constraint: "Verify Slack signatures / Telegram secret token on all
// callback endpoints").
function verifyTelegramSecret(req: Request): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  return req.header("X-Telegram-Bot-Api-Secret-Token") === expected;
}

// SPEC.md §6: Approve -> APPROVED (execution enqueue is Milestone 4, not
// wired yet). Reject -> REJECTED, optional reason. Non-allowlisted clicks
// are ignored + audited, never transitioned.
export async function handleTelegramCallback(req: Request, res: Response): Promise<void> {
  if (!verifyTelegramSecret(req)) {
    res.status(401).json({ error: "Invalid or missing secret token" });
    return;
  }

  // Telegram expects a fast 200 regardless of what we do with the update —
  // failures below are captured via audit_log, not via the HTTP response.
  res.status(200).json({ ok: true });

  const update = req.body as TelegramUpdate;
  const callback = update.callback_query;
  if (!callback?.data) return;

  const match = callback.data.match(CALLBACK_DATA_PATTERN);
  if (!match) return;

  const [, action, workflowId] = match;
  const approverId = String(callback.from.id);

  if (!getApproverAllowlist().has(approverId)) {
    await writeAuditLog({
      workflowId,
      actor: `telegram:${approverId}`,
      event: "approval_decision",
      detail: { decision: "unauthorized", by: approverId },
    });
    return;
  }

  const actor = `approver:${approverId}`;

  try {
    if (action === "approve") {
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
    // Illegal transition (already decided, wrong state) or workflow not
    // found — swallow rather than surface to Telegram; diagnosable via the
    // absence of a matching approval_decision entry plus the engine's own
    // error, which we don't have a channel to report here beyond logging.
    // eslint-disable-next-line no-console
    console.warn(`Telegram callback for workflow ${workflowId} failed: ${(err as Error).message}`);
  }
}
