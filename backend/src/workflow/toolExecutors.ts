import { prisma } from "../db/client";
import { hubspotGet, hubspotPatch, hubspotPost } from "../integrations/hubspot/client";

export type ToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

// Real implementations for the tools that map cleanly onto existing infra
// (HubSpot's OAuth client from v1, v1's tickets/activity_log tables).
//
// email.send has no honest implementation available: no email provider
// (SMTP/SendGrid/etc.) is integrated anywhere in v1 or v2's SPEC/env vars.
// Rather than fake a "sent" result, it's recorded to activity_log as a
// simulated send — clearly labeled, not claiming real delivery. Flagging
// this as a real gap, not building around it silently.
export const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  "hubspot.get_contact": async (args) => {
    return hubspotGet(`/crm/v3/objects/contacts/${args.contactId}`);
  },

  "hubspot.update_contact": async (args) => {
    return hubspotPatch(`/crm/v3/objects/contacts/${args.contactId}`, {
      properties: args.properties,
    });
  },

  "hubspot.create_deal": async (args) => {
    const properties: Record<string, unknown> = {
      dealname: args.dealName,
      dealstage: args.stage,
    };
    if (args.amount !== undefined) properties.amount = args.amount;

    const associations = args.contactId
      ? [
          {
            to: { id: args.contactId },
            types: [
              {
                associationCategory: "HUBSPOT_DEFINED",
                associationTypeId: 3, // deal_to_contact
              },
            ],
          },
        ]
      : undefined;

    return hubspotPost("/crm/v3/objects/deals", { properties, associations });
  },

  "hubspot.add_note": async (args) => {
    const properties = {
      hs_note_body: args.body,
      hs_timestamp: Date.now(),
    };
    const note = (await hubspotPost("/crm/v3/objects/notes", { properties })) as { id: string };

    await hubspotPost(`/crm/v3/objects/notes/${note.id}/associations/contacts/${args.contactId}`, {
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }], // note_to_contact
    });

    return note;
  },

  "ticket.update": async (args) => {
    const { ticketId, ...updates } = args as {
      ticketId: string;
      status?: string;
      category?: string;
      responseDraft?: string;
    };
    return prisma.ticket.update({ where: { id: ticketId }, data: updates });
  },

  "email.draft": async (args) => {
    const log = await prisma.activityLog.create({
      data: { type: "email.draft", refId: String(args.to), payload: args as object },
    });
    return { draftId: log.id, ...args };
  },

  "email.send": async (args) => {
    const log = await prisma.activityLog.create({
      data: { type: "email.send.simulated", refId: String(args.to), payload: args as object },
    });
    return { simulated: true, activityLogId: log.id, ...args };
  },
};
