import { beforeEach, describe, expect, it, vi } from "vitest";

const { hubspotGetMock, hubspotPatchMock, hubspotPostMock, ticketUpdateMock, activityLogCreateMock } =
  vi.hoisted(() => ({
    hubspotGetMock: vi.fn(),
    hubspotPatchMock: vi.fn(),
    hubspotPostMock: vi.fn(),
    ticketUpdateMock: vi.fn(),
    activityLogCreateMock: vi.fn(),
  }));

vi.mock("../integrations/hubspot/client", () => ({
  hubspotGet: hubspotGetMock,
  hubspotPatch: hubspotPatchMock,
  hubspotPost: hubspotPostMock,
  HubspotApiError: class HubspotApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
}));

vi.mock("../db/client", () => ({
  prisma: {
    ticket: { update: ticketUpdateMock },
    activityLog: { create: activityLogCreateMock },
  },
}));

import { TOOL_EXECUTORS } from "./toolExecutors";

describe("TOOL_EXECUTORS", () => {
  beforeEach(() => {
    hubspotGetMock.mockReset();
    hubspotPatchMock.mockReset();
    hubspotPostMock.mockReset();
    ticketUpdateMock.mockReset();
    activityLogCreateMock.mockReset();
  });

  it("hubspot.get_contact GETs the contact by id", async () => {
    hubspotGetMock.mockResolvedValue({ id: "42" });
    const result = await TOOL_EXECUTORS["hubspot.get_contact"]({ contactId: "42" });
    expect(hubspotGetMock).toHaveBeenCalledWith("/crm/v3/objects/contacts/42");
    expect(result).toEqual({ id: "42" });
  });

  it("hubspot.update_contact PATCHes properties", async () => {
    hubspotPatchMock.mockResolvedValue({ id: "42" });
    await TOOL_EXECUTORS["hubspot.update_contact"]({
      contactId: "42",
      properties: { lifecyclestage: "lead" },
    });
    expect(hubspotPatchMock).toHaveBeenCalledWith("/crm/v3/objects/contacts/42", {
      properties: { lifecyclestage: "lead" },
    });
  });

  it("hubspot.create_deal POSTs with dealname/dealstage and an association when contactId is given", async () => {
    hubspotPostMock.mockResolvedValue({ id: "deal-1" });
    await TOOL_EXECUTORS["hubspot.create_deal"]({
      dealName: "New Deal",
      stage: "appointmentscheduled",
      contactId: "42",
      amount: 1000,
    });

    const [path, body] = hubspotPostMock.mock.calls[0];
    expect(path).toBe("/crm/v3/objects/deals");
    expect(body.properties).toEqual({ dealname: "New Deal", dealstage: "appointmentscheduled", amount: 1000 });
    expect(body.associations[0].to).toEqual({ id: "42" });
  });

  it("hubspot.create_deal omits associations when no contactId is given", async () => {
    hubspotPostMock.mockResolvedValue({ id: "deal-2" });
    await TOOL_EXECUTORS["hubspot.create_deal"]({ dealName: "New Deal", stage: "appointmentscheduled" });
    const [, body] = hubspotPostMock.mock.calls[0];
    expect(body.associations).toBeUndefined();
  });

  it("hubspot.add_note creates a note and associates it with the contact", async () => {
    hubspotPostMock.mockResolvedValueOnce({ id: "note-1" }).mockResolvedValueOnce({});
    await TOOL_EXECUTORS["hubspot.add_note"]({ contactId: "42", body: "Called, no answer" });

    expect(hubspotPostMock).toHaveBeenNthCalledWith(
      1,
      "/crm/v3/objects/notes",
      expect.objectContaining({ properties: expect.objectContaining({ hs_note_body: "Called, no answer" }) }),
    );
    expect(hubspotPostMock).toHaveBeenNthCalledWith(
      2,
      "/crm/v3/objects/notes/note-1/associations/contacts/42",
      expect.anything(),
    );
  });

  it("ticket.update updates the ticket row by id with the remaining fields", async () => {
    ticketUpdateMock.mockResolvedValue({ id: "t-1", status: "resolved" });
    const result = await TOOL_EXECUTORS["ticket.update"]({ ticketId: "t-1", status: "resolved" });
    expect(ticketUpdateMock).toHaveBeenCalledWith({ where: { id: "t-1" }, data: { status: "resolved" } });
    expect(result).toEqual({ id: "t-1", status: "resolved" });
  });

  it("email.draft records to activity_log and returns a draftId", async () => {
    activityLogCreateMock.mockResolvedValue({ id: "log-1" });
    const result = (await TOOL_EXECUTORS["email.draft"]({
      to: "a@example.com",
      subject: "hi",
      body: "hello",
    })) as { draftId: string };

    expect(activityLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "email.draft" }) }),
    );
    expect(result.draftId).toBe("log-1");
  });

  it("email.send is honestly simulated — records to activity_log flagged as simulated, doesn't claim real delivery", async () => {
    activityLogCreateMock.mockResolvedValue({ id: "log-2" });
    const result = (await TOOL_EXECUTORS["email.send"]({
      to: "a@example.com",
      subject: "hi",
      body: "hello",
    })) as { simulated: boolean };

    expect(activityLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "email.send.simulated" }) }),
    );
    expect(result.simulated).toBe(true);
  });
});
