import { describe, expect, it } from "vitest";
import { resolveTemplatedArgs, resolveTemplatedValue } from "./templating";

describe("resolveTemplatedValue", () => {
  it("resolves a templated string to a nested field from a prior step's result", () => {
    const context = { 0: { contact_id: "hs-42", properties: { email: "a@example.com" } } };
    expect(resolveTemplatedValue("{{steps.0.result.contact_id}}", context)).toBe("hs-42");
    expect(resolveTemplatedValue("{{steps.0.result.properties.email}}", context)).toBe(
      "a@example.com",
    );
  });

  it("passes through non-template strings unchanged", () => {
    expect(resolveTemplatedValue("plain value", {})).toBe("plain value");
  });

  it("passes through non-string values unchanged", () => {
    expect(resolveTemplatedValue(42, {})).toBe(42);
    expect(resolveTemplatedValue(null, {})).toBe(null);
    expect(resolveTemplatedValue({ nested: true }, {})).toEqual({ nested: true });
  });

  it("returns undefined for a template referencing a step not in context", () => {
    expect(resolveTemplatedValue("{{steps.5.result.x}}", {})).toBeUndefined();
  });

  it("returns undefined for a field path that doesn't exist on the result", () => {
    const context = { 0: { contact_id: "1" } };
    expect(resolveTemplatedValue("{{steps.0.result.missing_field}}", context)).toBeUndefined();
  });
});

describe("resolveTemplatedArgs", () => {
  it("resolves templated fields while leaving literal fields untouched", () => {
    const context = { 0: { contact_id: "hs-42" } };
    const resolved = resolveTemplatedArgs(
      { contactId: "{{steps.0.result.contact_id}}", note: "literal text" },
      context,
    );
    expect(resolved).toEqual({ contactId: "hs-42", note: "literal text" });
  });
});
