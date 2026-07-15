import { beforeEach, describe, expect, it, vi } from "vitest";
import { Plan } from "../planner/plan";
import { getNotifier, renderApprovalMessage, TelegramNotifier } from "./notifier";

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

  it("throws for an unimplemented notifier kind (e.g. slack)", () => {
    process.env.NOTIFIER = "slack";
    expect(() => getNotifier()).toThrow('Notifier "slack" is not implemented');
  });
});
