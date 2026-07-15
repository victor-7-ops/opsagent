import { Plan } from "../planner/plan";

// SPEC.md §6 — one implementation behind NotifierPort, config NOTIFIER=slack|telegram.
// Only Telegram is wired in v2.0 (Issue 11 explicitly picks one); Slack would
// be a second NotifierPort implementation behind the same interface later.
export interface NotifierPort {
  sendApprovalRequest(workflowId: string, plan: Plan): Promise<{ messageRef: string }>;
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
}

export function renderApprovalMessage(plan: Plan): string {
  const stepLines = plan.steps
    .map((step, i) => `${i + 1}. ${step.tool} (${summarizeArgs(step.args)})`)
    .join("\n");

  return [
    "New workflow plan awaiting approval",
    "",
    plan.human_summary,
    "",
    `Risk level: ${plan.risk_level}`,
    "",
    "Steps:",
    stepLines,
  ].join("\n");
}

interface TelegramSendMessageResponse {
  ok: boolean;
  result: { message_id: number };
}

export class TelegramNotifier implements NotifierPort {
  async sendApprovalRequest(workflowId: string, plan: Plan): Promise<{ messageRef: string }> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is not set");
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: renderApprovalMessage(plan),
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `approve:${workflowId}` },
              { text: "❌ Reject", callback_data: `reject:${workflowId}` },
            ],
          ],
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telegram sendMessage failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as TelegramSendMessageResponse;
    return { messageRef: String(data.result.message_id) };
  }
}

export function getNotifier(): NotifierPort {
  const kind = process.env.NOTIFIER || "telegram";
  if (kind === "telegram") return new TelegramNotifier();
  throw new Error(`Notifier "${kind}" is not implemented — only "telegram" is wired in v2.0`);
}
