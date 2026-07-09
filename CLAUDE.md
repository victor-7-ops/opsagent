# CLAUDE.md — OpsAgent v2 (brownfield extension of OpsAgent v1)

Instructions for Claude Code sessions. This is an EXISTING repo — v1 is in production shape. Read SPEC.md and BUILDPLAN.md before any issue.

## Brownfield Rules (most important section)
- **Do not refactor v1 code** unless the issue explicitly requires it. v2 modules are additive under `src/workflow/`, `src/planner/`, `src/approval/`.
- Before your first change in a session, read the v1 modules you'll touch or call into (tool layer, HubSpot client, config) and summarize their actual interfaces in your plan — do not assume signatures from this doc.
- If a v1 interface doesn't match what SPEC.md expects, STOP and report the mismatch; propose an adapter rather than changing v1.
- `WORKFLOW_MODE=direct` must keep v1 behavior byte-for-byte. Every session must end with the existing v1 test suite still green.

## Session Rules
- One issue per session; no scope creep. Prerequisite discovered → stop and report.
- End every session with: all tests passing (old + new), conventional commit referencing the issue number, and a short summary of interface changes (if any).
- SPEC.md wins over the issue text; flag conflicts. Never edit SPEC.md / BUILDPLAN.md / this file unless the issue says so.

## Conventions
- TypeScript strict, no `any`. Zod at every boundary: trigger payloads, LLM plan output, notifier callbacks, env (fail fast at boot).
- All new LLM calls go through the planner module only — model `claude-sonnet-5`, strict JSON, one retry on parse failure, then dead-letter + audit. Never call the Anthropic SDK from workflow/executor code.
- State mutations ONLY via `engine.transition()`. Direct `update workflows set state=...` anywhere else is a review-blocking violation.
- Every transition, plan creation, approval decision, and step execution writes `audit_log`.
- Structured logging with the repo's existing logger; follow existing patterns for naming, error handling, and file layout where v1 already has a convention — v1 conventions beat this doc's preferences.

## Testing
- Unit tests for: full state machine transition matrix (legal + illegal), plan validator (each rejection reason), idempotent executor re-run, arg templating resolution, callback signature verification, approver allowlist.
- LLM mocked via fixtures in `tests/fixtures/plans/`. Live eval only via `npm run eval:planner` and only when the issue calls for it.
- HubSpot mocked at the v1 tool-layer boundary (never hit real HubSpot in tests).
- The invariant test: run a full suite pass and assert zero side-effect tool invocations occurred outside APPROVED workflows (spy on the tool layer).

## Hard Constraints (never violate)
- No side-effect tool executes without `workflows.state = 'APPROVED'` — enforced in the executor code path, not prompts.
- `risk_level=high` plans are always rejected in v2.0.
- Only tools in the launch registry are callable; adding a tool requires an explicit issue.
- No HubSpot scope expansion. No secrets in logs or commits.
- Idempotency keys are mandatory on every step — a step without one must not run.

## Commands
(Verify against the actual repo's package.json in your first session and correct this list if it differs — then report the corrections.)
- `npm run dev` — local server
- `npm test` — full suite (v1 + v2)
- `npm run eval:planner` — live planner eval (costs money)
- `npm run db:migrate` — apply migrations

## Out of Scope Reminders
Parallel execution, plan editing, multi-approver, dashboards, new tools. If an issue seems to need these, it's mis-scoped — stop and report.
