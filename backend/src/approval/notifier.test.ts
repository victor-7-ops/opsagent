import { beforeEach, describe, expect, it, vi } from "vitest";
import { Plan } from "../planner/plan";
import { getNotifier, renderApprovalMessage, SlackNotifier, TelegramNotifier } from "./notifier";

const SAMPLE_PLAN: Plan = {
  goal: "Route lead",
  risk_level: "low",
  steps: [
    { tool: "hubspot.get_contact", args: { contactId: "42" }, rationale: "resolve id", depends_on: [] },
    {
      tool: "email.draft",
      args: { to: "a@example.com", subject: "hi", body: "hello" },
      rationale: "draft reply",
      depends_on: [0],
    },
  ],
  human_summary: "Look up the lead and draft a reply for approval.",
};

describe("renderApprovalMessage", () => {
  it("includes the human summary, risk level, and a numbered step list with key args", () => {
    const message = renderApprovalMessage(SAMPLE_PLAN);
    expect(message).toContain("Look up the lead and draft a reply for approval.");
    expect(message).toContain("Risk level: low");
    expect(message).toContain("1. hubspot.get_contact");
    expect(message).toContain('contactId="42"');
    expect(message).toContain("2. email.draft");
  });
});

describe("TelegramNotifier", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "12345";
  });

  it("sends an inline-keyboard message with Approve/Reject callback data and returns the message id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 999 } }),
    });

    const notifier = new TelegramNotifier();
    const result = await notifier.sendApprovalRequest("wf-1", SAMPLE_PLAN);

    expect(result).toEqual({ messageRef: "999" });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage");
    const body = JSON.parse(options.body);
    expect(body.chat_id).toBe("12345");
    expect(body.reply_markup.inline_keyboard[0]).toEqual([
      { text: "✅ Approve", callback_data: "approve:wf-1" },
      { text: "❌ Reject", callback_data: "reject:wf-1" },
    ]);
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const notifier = new TelegramNotifier();
    await expect(notifier.sendApprovalRequest("wf-1", SAMPLE_PLAN)).rejects.toThrow(
      "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is not set",
    );
  });

  it("throws with the response body when Telegram returns a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "chat not found" });
    const notifier = new TelegramNotifier();
    await expect(notifier.sendApprovalRequest("wf-1", SAMPLE_PLAN)).rejects.toThrow(
      "Telegram sendMessage failed (400): chat not found",
    );
  });

  it("sendFailureSummary posts a plain (no-keyboard) message with the failed step and error", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) });
    const notifier = new TelegramNotifier();

    await notifier.sendFailureSummary("wf-1", "hubspot.update_contact", "HubSpot API error (500): timeout");

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.text).toContain("wf-1");
    expect(body.text).toContain("hubspot.update_contact");
    expect(body.text).toContain("HubSpot API error (500): timeout");
    expect(body.reply_markup).toBeUndefined();
  });

  it("sendFailureSummary throws when credentials are missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const notifier = new TelegramNotifier();
    await expect(notifier.sendFailureSummary("wf-1", "tool", "err")).rejects.toThrow(
      "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is not set",
    );
  });
});

describe("SlackNotifier", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
  });

  it("posts Block Kit with Approve/Reject buttons and returns the message ts", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: "1234.5678" }) });

    const notifier = new SlackNotifier();
    const result = await notifier.sendApprovalRequest("wf-1", SAMPLE_PLAN);

    expect(result).toEqual({ messageRef: "1234.5678" });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(options.headers.Authorization).toBe("Bearer xoxb-test");
    const body = JSON.parse(options.body);
    expect(body.channel).toBe("C123");
    const actionsBlock = body.blocks.find((b: { type: string }) => b.type === "actions");
    expect(actionsBlock.elements).toEqual([
      expect.objectContaining({ action_id: "approve", value: "wf-1" }),
      expect.objectContaining({ action_id: "reject", value: "wf-1" }),
    ]);
  });

  it("throws when SLACK_BOT_TOKEN is missing", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const notifier = new SlackNotifier();
    await expect(notifier.sendApprovalRequest("wf-1", SAMPLE_PLAN)).rejects.toThrow(
      "SLACK_BOT_TOKEN / SLACK_CHANNEL_ID is not set",
    );
  });

  it("throws on a Slack API-level error (ok:false in a 200 response)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: "channel_not_found" }) });
    const notifier = new SlackNotifier();
    await expect(notifier.sendApprovalRequest("wf-1", SAMPLE_PLAN)).rejects.toThrow(
      "Slack chat.postMessage failed: channel_not_found",
    );
  });

  it("sendFailureSummary posts a plain text message", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: "1" }) });
    const notifier = new SlackNotifier();
    await notifier.sendFailureSummary("wf-1", "email.send", "boom");

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.text).toContain("wf-1");
    expect(body.text).toContain("email.send");
    expect(body.text).toContain("boom");
    expect(body.blocks).toBeUndefined();
  });
});

describe("getNotifier", () => {
  it("defaults to Telegram when NOTIFIER is unset", () => {
    delete process.env.NOTIFIER;
    expect(getNotifier()).toBeInstanceOf(TelegramNotifier);
  });

  it("returns a TelegramNotifier when NOTIFIER=telegram", () => {
    process.env.NOTIFIER = "telegram";
    expect(getNotifier()).toBeInstanceOf(TelegramNotifier);
  });

  it("returns a SlackNotifier when NOTIFIER=slack", () => {
    process.env.NOTIFIER = "slack";
    expect(getNotifier()).toBeInstanceOf(SlackNotifier);
  });

  it("throws for an unimplemented notifier kind", () => {
    process.env.NOTIFIER = "carrier-pigeon";
    expect(() => getNotifier()).toThrow('Notifier "carrier-pigeon" is not implemented');
  });
});
