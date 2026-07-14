import { describe, expect, it } from "vitest";
import {
  getToolDef,
  isRegisteredTool,
  registryAsJsonSchema,
  TOOL_REGISTRY,
  toolArgsJsonSchema,
} from "./toolRegistry";

const LAUNCH_TOOLS = [
  "hubspot.get_contact",
  "hubspot.update_contact",
  "hubspot.create_deal",
  "hubspot.add_note",
  "email.draft",
  "email.send",
  "ticket.update",
];

describe("tool registry", () => {
  it("contains exactly the v2 launch registry — nothing more, nothing less", () => {
    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual(LAUNCH_TOOLS.sort());
  });

  it("only hubspot.get_contact is a read (sideEffect: false)", () => {
    for (const name of LAUNCH_TOOLS) {
      const tool = getToolDef(name);
      expect(tool).toBeDefined();
      if (name === "hubspot.get_contact") {
        expect(tool?.sideEffect).toBe(false);
      } else {
        expect(tool?.sideEffect).toBe(true);
      }
    }
  });

  it("caps email.send at 1 per plan (irreversible)", () => {
    expect(getToolDef("email.send")?.maxPerPlan).toBe(1);
  });

  it("every tool has a positive maxPerPlan", () => {
    for (const tool of Object.values(TOOL_REGISTRY)) {
      expect(tool.maxPerPlan).toBeGreaterThan(0);
    }
  });

  it("isRegisteredTool rejects anything outside the launch registry", () => {
    expect(isRegisteredTool("hubspot.get_contact")).toBe(true);
    expect(isRegisteredTool("hubspot.delete_contact")).toBe(false);
    expect(isRegisteredTool("shell.exec")).toBe(false);
  });

  it("argsSchema validates well-formed args and rejects malformed ones", () => {
    const tool = getToolDef("email.send")!;
    expect(
      tool.argsSchema.safeParse({ to: "a@example.com", subject: "hi", body: "hello" }).success,
    ).toBe(true);
    expect(tool.argsSchema.safeParse({ to: "not-an-email", subject: "hi", body: "hello" }).success).toBe(
      false,
    );
    expect(tool.argsSchema.safeParse({}).success).toBe(false);
  });

  it("exports a JSON Schema for a single tool's args", () => {
    const schema = toolArgsJsonSchema(getToolDef("hubspot.get_contact")!) as {
      definitions: Record<string, { properties: Record<string, unknown> }>;
    };
    expect(schema.definitions["hubspot.get_contact"].properties).toHaveProperty("contactId");
  });

  it("exports the full registry as JSON Schema for prompt injection", () => {
    const registrySchema = registryAsJsonSchema();
    expect(Object.keys(registrySchema).sort()).toEqual(LAUNCH_TOOLS.sort());
    expect(registrySchema["email.send"]).toMatchObject({ sideEffect: true, maxPerPlan: 1 });
  });
});
