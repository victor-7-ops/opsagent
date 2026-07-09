# BUILDPLAN — OpsAgent v2: Agentic Escalation & Approval-Gated Autonomy

## Goal
Extend OpsAgent from reactive CRM automation into a multi-step agentic workflow engine: triage → CRM update → drafted response → human approval gate → execution. Portfolio target: Agentic AI Developer roles.

## Stack
- Node.js 20 / TypeScript (reuse OpsAgent v1 codebase)
- Claude API (Fable 5) with tool use + extended thinking
- HubSpot OAuth (existing), n8n webhooks (existing)
- ChromaDB RAG (existing) — extend with workflow-policy documents
- Postgres for workflow state machine + audit log
- Telegram or Slack for approval-gate notifications

## Architecture Delta from v1
- New `WorkflowEngine` service: state machine (TRIAGED → PLANNED → AWAITING_APPROVAL → EXECUTING → DONE / REJECTED)
- New `AgentPlanner`: Claude generates a structured JSON action plan (tool calls it *intends* to make) before executing anything
- Approval gate: plan is posted to Slack/Telegram with Approve/Reject buttons (webhook callback)
- Executor replays approved plan with idempotency keys

## Milestone 1 — Workflow State Machine (Issues 1–5)
1. Postgres schema: `workflows`, `workflow_steps`, `audit_log` tables + migrations
2. `WorkflowEngine` class: state transitions, guards, event emission
3. Idempotency key middleware for all outbound actions
4. Unit tests for state machine (all legal/illegal transitions)
5. Audit log writer with structured JSON events

## Milestone 2 — Agent Planner (Issues 6–10)
6. Define tool schema registry (HubSpot ops, email draft, ticket update) as JSON schemas
7. Planner prompt: Claude outputs `{steps: [{tool, args, rationale}]}` — strict JSON, validated with zod
8. RAG context injection: pull relevant client policy docs from ChromaDB into planner prompt
9. Plan validator: reject plans referencing unknown tools/entities
10. Integration test: inbound email fixture → valid plan produced

## Milestone 3 — Approval Gate (Issues 11–14)
11. Slack/Telegram notifier: render plan as human-readable summary + buttons
12. Callback webhook: approve/reject → state transition
13. Timeout policy: auto-expire plans after 24h → REJECTED
14. Partial approval: allow editing plan args before approval (stretch)

## Milestone 4 — Executor + Demo (Issues 15–18)
15. Executor: run approved steps sequentially, retry with backoff, halt-on-failure
16. End-to-end happy path test with mocked HubSpot
17. Reporting dashboard tile: workflows by state, approval latency
18. Demo script + README with architecture diagram + 2-min Loom walkthrough

## Acceptance Criteria
- Zero side effects without an approved plan (verified by audit log)
- Full replay-safe execution (re-running executor is a no-op)
- Demoable in <5 minutes from a single inbound email fixture
