# OpsAgent

AI teammates for sales and client ops — autonomous agents that route leads, triage support tickets, and (in v2) plan multi-step actions with a human approval gate before anything touches a real system.

Built as a portfolio project targeting **Agentic AI Developer** roles: production-shaped Node.js/TypeScript backend, real OAuth integration (HubSpot), Claude-based agent orchestration, deterministic automation (n8n), RAG (ChromaDB), and an approval-gated workflow engine — not a toy chatbot demo.

## Why this exists

Sales and client-service teams burn hours a week on repetitive, judgment-adjacent work: routing leads, drafting follow-ups, triaging tickets, escalating risk. Most SMB tooling (HubSpot workflows, Zapier) is either rigid if/then trees or disconnected from natural-language judgment calls. OpsAgent puts an LLM agent layer on top of a CRM, with a deterministic automation layer underneath handling triggers, retries, and logging — and, in v2, a hard approval gate so the agent can *plan* actions without unilaterally *executing* them.

## Two builds, one codebase

### v1 — Reactive CRM Automation
- HubSpot OAuth2 integration (real sandbox, encrypted token storage, auto-refresh)
- Lead Routing & Follow-Up Agent: HubSpot webhook → Claude scores/assigns lead → drafted follow-up email (draft-only, human sends)
- Client Ticket / Escalation Agent: severity/category classification, RAG-backed FAQ responses (ChromaDB), SLA breach monitoring
- n8n for triggers, retries, delayed follow-ups; Telegram alerting on failure
- Full Docker Compose stack (backend, Postgres, n8n), deployed to a Linux VPS

### v2 — Agentic Escalation & Approval-Gated Autonomy (in progress)
Extends v1 from reactive automation into a multi-step agentic workflow engine:

```
inbound trigger → AgentPlanner (Claude, structured JSON plan) → WorkflowEngine
  (state machine) → human approval gate (Slack/Telegram) → Executor → real systems
```

**Core invariant: no side effect — HubSpot write, email send, ticket update — ever executes without an approved plan.** Enforced in code (executor path), not prompts.

- State machine: `TRIAGED → PLANNED → AWAITING_APPROVAL → APPROVED → EXECUTING → DONE`, with `REJECTED`/`EXPIRED`/`FAILED` branches, every transition audited
- Planner: Claude emits a validated, tool-scoped JSON plan (zod-checked), grounded with RAG-retrieved policy docs (ChromaDB) — never calls tools directly, only proposes them
- Validator: rejects unknown tools, schema violations, `maxPerPlan` overages, dependency cycles, unresolved entity IDs, and any `risk_level=high` plan outright
- Approval gate: plan rendered as a human-readable summary with Approve/Reject buttons in **Telegram or Slack** (both real, switchable via `NOTIFIER=telegram|slack`); allowlisted approvers only, non-allowlisted clicks are ignored + audited; a stretch feature (per-step arg editing before approval) is implemented too
- 24h approval timeout → `EXPIRED`, swept by a scheduled n8n job
- Executor: idempotent (re-running is always a no-op for completed steps), retried with 1s/4s/16s backoff on network/5xx only, halts and notifies on failure — real HubSpot API calls for contact/deal/note operations, ticket updates against the live `tickets` table
- `GET /stats`: workflow counts by state + approval latency

**Real gap, not hidden:** no email provider is integrated anywhere in this project. `email.draft`/`email.send` are honestly recorded to `activity_log` — `email.send` is explicitly flagged `simulated`, not claiming real delivery.

## Stack

Node.js 20 · TypeScript (strict) · Express · Prisma/Postgres · Claude API (Anthropic) · n8n · ChromaDB (RAG) · Docker Compose · HubSpot OAuth2 · Telegram/Slack

## Status

- [x] v1 Phase 0–1: repo scaffold, Docker Compose, Postgres schema, HubSpot OAuth, webhook receiver, lead routing
- [ ] v1 Phase 1 remainder: follow-up drafting, deal-stage delayed follow-up, failure alerting
- [ ] v1 Phase 2: ticket triage, RAG knowledge base, escalation flagging, SLA monitor
- [ ] v1 Phase 3: dashboard, deployment
- [x] v2 Milestone 1 — Workflow State Machine: schema, `WorkflowEngine`, idempotency, audit log
- [x] v2 Milestone 2 — Agent Planner: tool registry, planner + retry/dead-letter, RAG injection, validator, integration test
- [x] v2 Milestone 3 — Approval Gate: Telegram + Slack notifiers, callback handlers, expiry sweep, plan-editing (stretch)
- [x] v2 Milestone 4 — Executor: real tool implementations, idempotent/retrying executor, `GET /stats`
- [ ] Slack live-verification (code complete + tested, not yet run against a real Slack app)
- [ ] Demo script / Loom walkthrough (BUILDPLAN Issue 18) — skipped for now

227 backend tests passing (`cd backend && npm test`). See [SPEC.md](SPEC.md) / [BUILDPLAN.md](BUILDPLAN.md) for the full v2 design and issue breakdown.

v1 build history and original spec: [`docs/v1/`](docs/v1/).

## Local setup

```bash
cp .env.example .env   # fill in HubSpot, Anthropic, Telegram creds
docker compose up -d --build
curl http://localhost:3000/health
```

See [CLAUDE.md](CLAUDE.md) for working conventions and [SPEC.md](SPEC.md) for full v2 architecture.
