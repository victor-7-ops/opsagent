// SPEC.md §7: "Read-step outputs are appended to an execution context passed
// to later steps (arg templating: "{{steps.0.result.contact_id}}" resolved
// by executor)."
const TEMPLATE_PATTERN = /^\{\{\s*steps\.(\d+)\.result\.(.+?)\s*\}\}$/;

export type ExecutionContext = Record<number, unknown>; // stepIndex -> that step's result

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

export function resolveTemplatedValue(value: unknown, context: ExecutionContext): unknown {
  if (typeof value !== "string") return value;
  const match = value.match(TEMPLATE_PATTERN);
  if (!match) return value;

  const [, stepIndexStr, fieldPath] = match;
  const stepResult = context[Number(stepIndexStr)];
  return getPath(stepResult, fieldPath);
}

export function resolveTemplatedArgs(
  args: Record<string, unknown>,
  context: ExecutionContext,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, resolveTemplatedValue(value, context)]),
  );
}
