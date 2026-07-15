import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// SPEC.md §5.1 — the v2 launch registry. Nothing else is callable (CLAUDE.md
// hard constraint: "Only tools in the launch registry are callable; adding a
// tool requires an explicit issue"). No HubSpot scope expansion beyond v1.
export interface ToolDef {
  name: string;
  description: string;
  argsSchema: z.ZodType;
  sideEffect: boolean; // false → may run without approval (reads)
  maxPerPlan: number;
}

const hubspotGetContact: ToolDef = {
  name: "hubspot.get_contact",
  description: "Read a HubSpot contact by ID. Read-only, no side effect.",
  argsSchema: z.object({
    contactId: z.string().min(1),
  }),
  sideEffect: false,
  maxPerPlan: 5,
};

const hubspotUpdateContact: ToolDef = {
  name: "hubspot.update_contact",
  description: "Update properties on an existing HubSpot contact.",
  argsSchema: z.object({
    contactId: z.string().min(1),
    properties: z.record(z.string()),
  }),
  sideEffect: true,
  maxPerPlan: 3,
};

const hubspotCreateDeal: ToolDef = {
  name: "hubspot.create_deal",
  description: "Create a new HubSpot deal, optionally associated with a contact.",
  argsSchema: z.object({
    dealName: z.string().min(1).max(200),
    stage: z.string().min(1),
    contactId: z.string().min(1).optional(),
    amount: z.number().nonnegative().optional(),
  }),
  sideEffect: true,
  maxPerPlan: 1,
};

const hubspotAddNote: ToolDef = {
  name: "hubspot.add_note",
  description: "Add a note to a HubSpot contact's timeline.",
  argsSchema: z.object({
    contactId: z.string().min(1),
    body: z.string().min(1).max(5000),
  }),
  sideEffect: true,
  maxPerPlan: 3,
};

const emailDraft: ToolDef = {
  name: "email.draft",
  description: "Create a stored email draft. Does not send anything.",
  argsSchema: z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1),
  }),
  sideEffect: true,
  maxPerPlan: 3,
};

const emailSend: ToolDef = {
  name: "email.send",
  description: "Send an email. Irreversible — at most one per plan.",
  argsSchema: z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1),
  }),
  sideEffect: true,
  maxPerPlan: 1,
};

const ticketUpdate: ToolDef = {
  name: "ticket.update",
  description: "Update a support ticket's status, category, or response draft.",
  argsSchema: z.object({
    ticketId: z.string().min(1),
    status: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    responseDraft: z.string().optional(),
  }),
  sideEffect: true,
  maxPerPlan: 3,
};

export const TOOL_REGISTRY: Record<string, ToolDef> = {
  [hubspotGetContact.name]: hubspotGetContact,
  [hubspotUpdateContact.name]: hubspotUpdateContact,
  [hubspotCreateDeal.name]: hubspotCreateDeal,
  [hubspotAddNote.name]: hubspotAddNote,
  [emailDraft.name]: emailDraft,
  [emailSend.name]: emailSend,
  [ticketUpdate.name]: ticketUpdate,
};

export function getToolDef(name: string): ToolDef | undefined {
  return TOOL_REGISTRY[name];
}

export function isRegisteredTool(name: string): boolean {
  return name in TOOL_REGISTRY;
}

// JSON Schema for a single tool's args — used when injecting the registry
// into the planner prompt (SPEC.md §5.2).
export function toolArgsJsonSchema(tool: ToolDef): object {
  return zodToJsonSchema(tool.argsSchema as z.ZodTypeAny, tool.name);
}

// The full registry as JSON Schema, keyed by tool name, for prompt injection.
export function registryAsJsonSchema(): Record<string, object> {
  return Object.fromEntries(
    Object.values(TOOL_REGISTRY).map((tool) => [
      tool.name,
      {
        description: tool.description,
        sideEffect: tool.sideEffect,
        maxPerPlan: tool.maxPerPlan,
        argsSchema: toolArgsJsonSchema(tool),
      },
    ]),
  );
}
