import Anthropic from "@anthropic-ai/sdk";
import { writeAuditLog } from "../workflow/audit";
import { Plan, PlanSchema } from "./plan";
import { queryPolicyDocs } from "./rag";
import { registryAsJsonSchema } from "./toolRegistry";

const PLANNER_MODEL = "claude-sonnet-5";
const MAX_ATTEMPTS = 2; // one retry on parse/validation failure, per CLAUDE.md

const HARD_RULES = [
  "Never invent entity IDs — use a read step first to resolve them.",
  "At most one email.send step per plan.",
  "If the available information is insufficient, output a plan whose only step is email.draft asking for clarification.",
].join("\n- ");

export class PlanParseError extends Error {
  constructor(reason: string) {
    super(`Planner output failed to parse/validate: ${reason}`);
    this.name = "PlanParseError";
  }
}

export class PlannerDeadLetterError extends Error {
  constructor(workflowId: string, attempts: number, lastError: string) {
    super(
      `Planner dead-lettered for workflow ${workflowId} after ${attempts} attempts: ${lastError}`,
    );
    this.name = "PlannerDeadLetterError";
  }
}

interface PlannerInput {
  workflowId: string;
  triggerPayload: unknown;
  ragChunks?: string[]; // top policy-doc chunks; RAG retrieval wiring is Issue 8
}

export function buildPlannerPrompt(input: PlannerInput): string {
  const ragSection = input.ragChunks?.length
    ? `Relevant policy context:\n${input.ragChunks.join("\n---\n")}\n\n`
    : "";

  return `You are OpsAgent's planning module. Given a trigger event, produce a structured action plan.

Available tools (JSON Schema, args must validate against the listed schema):
${JSON.stringify(registryAsJsonSchema(), null, 2)}

Hard rules:
- ${HARD_RULES}

${ragSection}Trigger payload:
${JSON.stringify(input.triggerPayload, null, 2)}

Respond with ONLY a single JSON object — no markdown fences, no prose before or after — matching:
{
  "goal": string (max 300 chars),
  "risk_level": "low" | "medium" | "high",
  "steps": [{ "tool": string, "args": object, "rationale": string (max 300 chars), "depends_on": number[] }],
  "human_summary": string (max 600 chars, shown to a human approver)
}`;
}

async function callClaude(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: PLANNER_MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new PlanParseError("Claude response contained no text block");
  }
  return textBlock.text;
}

export function parsePlan(raw: string): Plan {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PlanParseError("response was not valid JSON");
  }

  const result = PlanSchema.safeParse(json);
  if (!result.success) {
    throw new PlanParseError(result.error.message);
  }
  return result.data;
}

// The only place in the codebase allowed to call the Anthropic SDK
// (CLAUDE.md: "Never call the Anthropic SDK from workflow/executor code").
// One retry on parse/validation failure; two failures dead-letters the
// workflow (audit_log write) and throws.
export async function generatePlan(input: PlannerInput): Promise<Plan> {
  const prompt = buildPlannerPrompt(input);

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await callClaude(prompt);
      return parsePlan(raw);
    } catch (err) {
      lastError = err as Error;
    }
  }

  await writeAuditLog({
    workflowId: input.workflowId,
    actor: "planner",
    event: "plan_rejected",
    detail: { reason: `Planner failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}` },
  });

  throw new PlannerDeadLetterError(input.workflowId, MAX_ATTEMPTS, lastError?.message ?? "unknown error");
}

interface PlanWorkflowInput {
  workflowId: string;
  triggerPayload: unknown;
  ragQuery?: string; // defaults to a stringified triggerPayload
}

// Wraps generatePlan() with RAG retrieval (SPEC.md §5.2: "RAG-retrieved
// policy docs (top 4 chunks)"). Kept separate from generatePlan so the core
// planner stays trivially testable with an explicit ragChunks array.
export async function planWorkflow(input: PlanWorkflowInput): Promise<Plan> {
  const ragQuery = input.ragQuery ?? JSON.stringify(input.triggerPayload);
  const ragChunks = await queryPolicyDocs(ragQuery);

  return generatePlan({
    workflowId: input.workflowId,
    triggerPayload: input.triggerPayload,
    ragChunks,
  });
}
