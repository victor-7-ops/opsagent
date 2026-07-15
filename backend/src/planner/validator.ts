import { Plan } from "./plan";
import { getToolDef, isRegisteredTool } from "./toolRegistry";

export interface PlanValidationResult {
  valid: boolean;
  reasons: string[];
}

interface ValidateContext {
  triggerPayload: unknown;
}

// A prior read step's result is referenced via executor arg-templating
// ("{{steps.0.result.contact_id}}", SPEC.md §7), not by literal value — the
// planner never sees real entity IDs from reads at plan time.
const STEP_RESULT_TEMPLATE = /^\{\{\s*steps\.(\d+)\.result\..+\}\}$/;

// Heuristic for "this arg value is an entity ID that must be traceable to
// the trigger payload or a prior read step" — keys ending in Id.
const ENTITY_ID_KEY = /Id$/;

function findDependencyCycle(plan: Plan): number | null {
  const n = plan.steps.length;
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Array(n).fill(WHITE);

  function visit(i: number): boolean {
    color[i] = GRAY;
    for (const dep of plan.steps[i].depends_on) {
      if (dep < 0 || dep >= n) continue; // out-of-range handled separately
      if (color[dep] === GRAY) return true;
      if (color[dep] === WHITE && visit(dep)) return true;
    }
    color[i] = BLACK;
    return false;
  }

  for (let i = 0; i < n; i++) {
    if (color[i] === WHITE && visit(i)) return i;
  }
  return null;
}

function isEntityIdResolvable(value: string, stepIndex: number, plan: Plan, triggerPayload: unknown): boolean {
  const templateMatch = value.match(STEP_RESULT_TEMPLATE);
  if (templateMatch) {
    const refIndex = Number(templateMatch[1]);
    if (refIndex >= stepIndex || refIndex < 0 || refIndex >= plan.steps.length) return false;
    const refTool = getToolDef(plan.steps[refIndex].tool);
    return refTool !== undefined && refTool.sideEffect === false; // must be a read
  }
  // Otherwise the value must appear literally somewhere in the trigger payload.
  return JSON.stringify(triggerPayload).includes(JSON.stringify(value).slice(1, -1));
}

// Runs after the LLM produces a plan — code, not a prompt (SPEC.md §5.3).
// Collects every violation rather than failing fast, so a rejection audit
// entry / human-facing message can explain all the reasons at once.
export function validatePlan(plan: Plan, context: ValidateContext): PlanValidationResult {
  const reasons: string[] = [];

  // v2 policy: high-risk plans are always rejected — handle manually (CLAUDE.md hard constraint).
  if (plan.risk_level === "high") {
    reasons.push("risk_level=high plans are always rejected in v2.0; handle manually");
  }

  const toolCounts = new Map<string, number>();

  plan.steps.forEach((step, i) => {
    if (!isRegisteredTool(step.tool)) {
      reasons.push(`Step ${i}: unknown tool "${step.tool}" (not in the launch registry)`);
      return;
    }

    const tool = getToolDef(step.tool)!;
    toolCounts.set(tool.name, (toolCounts.get(tool.name) ?? 0) + 1);

    const argsResult = tool.argsSchema.safeParse(step.args);
    if (!argsResult.success) {
      reasons.push(`Step ${i}: args for "${step.tool}" failed validation: ${argsResult.error.message}`);
    }

    for (const [key, value] of Object.entries(step.args)) {
      if (!ENTITY_ID_KEY.test(key) || typeof value !== "string") continue;
      if (!isEntityIdResolvable(value, i, plan, context.triggerPayload)) {
        reasons.push(
          `Step ${i}: entity ID "${value}" (field "${key}") is not present in the trigger payload ` +
            `or a prior read step's declared output`,
        );
      }
    }

    for (const dep of step.depends_on) {
      if (dep < 0 || dep >= plan.steps.length) {
        reasons.push(`Step ${i}: depends_on references out-of-range step index ${dep}`);
      } else if (dep >= i) {
        reasons.push(`Step ${i}: depends_on references step ${dep}, which is not earlier in the plan`);
      }
    }
  });

  for (const [toolName, count] of toolCounts) {
    const tool = getToolDef(toolName)!;
    if (count > tool.maxPerPlan) {
      reasons.push(`Tool "${toolName}" used ${count} times, exceeding maxPerPlan (${tool.maxPerPlan})`);
    }
  }

  const cycleAt = findDependencyCycle(plan);
  if (cycleAt !== null) {
    reasons.push(`Dependency cycle detected involving step ${cycleAt}`);
  }

  return { valid: reasons.length === 0, reasons };
}
