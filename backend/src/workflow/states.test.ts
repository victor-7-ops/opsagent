import { describe, expect, it } from "vitest";
import { findTransition, TRANSITIONS, WorkflowEvent, WorkflowState } from "./states";

const ALL_STATES: WorkflowState[] = [
  "TRIAGED",
  "PLANNED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "DONE",
  "REJECTED",
  "FAILED",
  "EXPIRED",
];

const ALL_EVENTS: WorkflowEvent[] = [
  "CREATE_PLAN",
  "SUBMIT_FOR_APPROVAL",
  "VALIDATION_FAILED",
  "APPROVE",
  "REJECT",
  "EXPIRE",
  "START_EXECUTION",
  "COMPLETE",
  "FAIL",
];

describe("state machine transition matrix", () => {
  // Exhaustive: every (state, event) pair is asserted, not just the legal ones.
  for (const from of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      const expected = TRANSITIONS.find((t) => t.from === from && t.event === event);

      if (expected) {
        it(`${from} + ${event} -> ${expected.to} (legal)`, () => {
          const result = findTransition(from, event);
          expect(result).toBeDefined();
          expect(result?.to).toBe(expected.to);
        });
      } else {
        it(`${from} + ${event} -> illegal`, () => {
          expect(findTransition(from, event)).toBeUndefined();
        });
      }
    }
  }

  it("covers every state reachable from SPEC.md §4's diagram", () => {
    const reachable = new Set(TRANSITIONS.map((t) => t.to));
    reachable.add("TRIAGED"); // initial state, not a transition target
    expect(reachable).toEqual(new Set(ALL_STATES));
  });

  it("has no duplicate (from, event) pairs — a deterministic machine can't branch on the same event", () => {
    const seen = new Set<string>();
    for (const t of TRANSITIONS) {
      const key = `${t.from}:${t.event}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
