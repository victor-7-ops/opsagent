export type WorkflowState =
  | "TRIAGED"
  | "PLANNED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "DONE"
  | "REJECTED"
  | "FAILED"
  | "EXPIRED";

export type WorkflowEvent =
  | "CREATE_PLAN"
  | "SUBMIT_FOR_APPROVAL"
  | "VALIDATION_FAILED"
  | "APPROVE"
  | "REJECT"
  | "EXPIRE"
  | "START_EXECUTION"
  | "COMPLETE"
  | "FAIL";

interface TransitionDef {
  from: WorkflowState;
  event: WorkflowEvent;
  to: WorkflowState;
}

// Mirrors SPEC.md §4 exactly:
//   TRIAGED → PLANNED → AWAITING_APPROVAL → APPROVED → EXECUTING → DONE
//   PLANNED → REJECTED            (validator failure)
//   AWAITING_APPROVAL → REJECTED  (human) | EXPIRED (24h timeout)
//   EXECUTING → FAILED            (step failure after retries)
export const TRANSITIONS: TransitionDef[] = [
  { from: "TRIAGED", event: "CREATE_PLAN", to: "PLANNED" },
  { from: "PLANNED", event: "SUBMIT_FOR_APPROVAL", to: "AWAITING_APPROVAL" },
  { from: "PLANNED", event: "VALIDATION_FAILED", to: "REJECTED" },
  { from: "AWAITING_APPROVAL", event: "APPROVE", to: "APPROVED" },
  { from: "AWAITING_APPROVAL", event: "REJECT", to: "REJECTED" },
  { from: "AWAITING_APPROVAL", event: "EXPIRE", to: "EXPIRED" },
  { from: "APPROVED", event: "START_EXECUTION", to: "EXECUTING" },
  { from: "EXECUTING", event: "COMPLETE", to: "DONE" },
  { from: "EXECUTING", event: "FAIL", to: "FAILED" },
];

export function findTransition(
  from: WorkflowState,
  event: WorkflowEvent,
): TransitionDef | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.event === event);
}
