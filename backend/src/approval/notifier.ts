import { Plan } from "../planner/plan";

// SPEC.md §6 — NOTIFIER=slack|telegram selects the implementation behind
// this single interface. Telegram (Issue 11) and Slack were both built;
// SPEC.md only required picking one, but both are real, tested implementations.
export interface NotifierPort {
  sendApprovalRequest(workflowId: string, plan: Plan): Promise<{ messageRef: string }>;
  // SPEC.md §7: "Step failure after retries -> workflow FAILED, remaining
  // steps skipped, notifier gets a failure summary with partial results."
  sendFailureSummary(workflowId: string, failedStep: string, error: string): Promise<void>;
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

  async sendFailureSummary(workflowId: string, failedStep: string, error: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is not set");
    }

    const text = [
      `Workflow ${workflowId} failed`,
      "",
      `Failed step: ${failedStep}`,
      `Error: ${error}`,
      "",
      "Remaining steps were skipped. Partial results are in the audit log.",
    ].join("\n");

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!res.ok) {
      const responseText = await res.text();
      throw new Error(`Telegram sendMessage failed (${res.status}): ${responseText}`);
    }
  }
}

interface SlackPostMessageResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

// Slack: Block Kit + interactivity endpoint (SPEC.md §6). Buttons carry
// action_id "approve"/"reject" and value=workflowId — parsed by the
// interactivity callback handler (routes/slack.ts).
export class SlackNotifier implements NotifierPort {
  async sendApprovalRequest(workflowId: string, plan: Plan): Promise<{ messageRef: string }> {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_CHANNEL_ID;
    if (!token || !channel) {
      throw new Error("SLACK_BOT_TOKEN / SLACK_CHANNEL_ID is not set");
    }

    const stepLines = plan.steps
      .map((step, i) => `${i + 1}. \`${step.tool}\` (${summarizeArgs(step.args)})`)
      .join("\n");

    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `*New workflow plan awaiting approval*\n${plan.human_summary}` } },
      { type: "section", text: { type: "mrkdwn", text: `*Risk level:* ${plan.risk_level}\n*Steps:*\n${stepLines}` } },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "✅ Approve" }, style: "primary", action_id: "approve", value: workflowId },
          { type: "button", text: { type: "plain_text", text: "❌ Reject" }, style: "danger", action_id: "reject", value: workflowId },
        ],
      },
    ];

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text: renderApprovalMessage(plan), blocks }),
    });

    const data = (await res.json()) as SlackPostMessageResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack chat.postMessage failed: ${data.error ?? res.status}`);
    }

    return { messageRef: data.ts! };
  }

  async sendFailureSummary(workflowId: string, failedStep: string, error: string): Promise<void> {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_CHANNEL_ID;
    if (!token || !channel) {
      throw new Error("SLACK_BOT_TOKEN / SLACK_CHANNEL_ID is not set");
    }

    const text = [
      `Workflow ${workflowId} failed`,
      "",
      `Failed step: ${failedStep}`,
      `Error: ${error}`,
      "",
      "Remaining steps were skipped. Partial results are in the audit log.",
    ].join("\n");

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text }),
    });

    const data = (await res.json()) as SlackPostMessageResponse;
    if (!res.ok || !data.ok) {
      throw new Error(`Slack chat.postMessage failed: ${data.error ?? res.status}`);
    }
  }
}

export function getNotifier(): NotifierPort {
  const kind = process.env.NOTIFIER || "telegram";
  if (kind === "telegram") return new TelegramNotifier();
  if (kind === "slack") return new SlackNotifier();
  throw new Error(`Notifier "${kind}" is not implemented`);
}
