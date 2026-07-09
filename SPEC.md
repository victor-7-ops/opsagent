# SPEC.md — OpsAgent v2: Agentic Escalation & Approval-Gated Workflows

Extension of OpsAgent v1 (Claude API + n8n + ChromaDB RAG + HubSpot OAuth). v2 adds a workflow engine that lets the agent PLAN multi-step actions, get human approval, then EXECUTE — turning reactive automation into approval-gated autonomy.

**Core invariant: no side effect (HubSpot write, email send, ticket update) ever executes without an approved plan.**

---

## 1. System Overview

```
inbound trigger (email / n8n webhook / HubSpot event)
        │
        ▼
┌───────────────┐   RAG context    ┌────────────┐
│ AgentPlanner  │◀────────────────│ ChromaDB    │
│ (Sonnet 5)    │                  │ (policies)  │
└──────┬────────┘                  └────────────┘
       │ structured plan (JSON)
       ▼
┌───────────────┐    Approve/Reject     ┌──────────────┐
│ WorkflowEngine│◀─────────────────────│ Slack/Telegram│
│ (state machine)│                      │ approval gate │
└──────┬────────┘                       └──────────────┘
       │ approved steps
       ▼
┌───────────────┐
│ Executor      │──▶ HubSpot / email / tickets (via existing v1 tool layer)
└───────────────┘
```

## 2. Integration with v1 — What Stays, What Changes
**Reuse as-is:** HubSpot OAuth client, ChromaDB RAG retrieval, existing tool implementations (contact update, deal ops, email draft), n8n webhook entry points, env/config loading.

**New modules (additive — do not refactor v1 modules unless an issue says so):**
```
src/
  workflow/
    engine.ts          # state machine
    states.ts          # transitions + guards
    executor.ts        # step runner
  planner/
    planner.ts         # Claude planning call
    toolRegistry.ts    # JSON-schema registry of allowed tools
    validator.ts       # plan validation
  approval/
    notifier.ts        # Slack or Telegram (pick ONE in Issue 11 via config)
    callbacks.ts       # approve/reject webhook handlers
  db/migrations/       # new tables below
```

**Changed behavior:** v1's direct "trigger → tool call" path is preserved behind a feature flag `WORKFLOW_MODE=direct|gated`. Default `gated` once Milestone 4 passes. This gives a safe rollback and a great demo comparison.

## 3. Data Model (Postgres — new tables)

```sql
create table workflows (
  id uuid primary key default gen_random_uuid(),
  trigger_type text not null,          -- 'email' | 'n8n_webhook' | 'hubspot_event'
  trigger_payload jsonb not null,
  state text not null default 'TRIAGED' check (state in
    ('TRIAGED','PLANNED','AWAITING_APPROVAL','APPROVED','EXECUTING','DONE','REJECTED','FAILED','EXPIRED')),
  plan jsonb,                          -- validated Plan object
  plan_summary text,                   -- human-readable, for the approval message
  approved_by text,
  notifier_message_ref text,           -- Slack ts or Telegram message id
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id),
  step_index int not null,
  tool text not null,
  args jsonb not null,
  idempotency_key text not null unique,   -- hash(workflow_id, step_index, tool, args)
  status text not null default 'pending' check (status in
    ('pending','running','succeeded','failed','skipped')),
  result jsonb,
  attempts int default 0,
  executed_at timestamptz,
  unique (workflow_id, step_index)
);

create table audit_log (
  id bigserial primary key,
  workflow_id uuid,
  actor text not null,                 -- 'planner' | 'engine' | 'executor' | approver id
  event text not null,                 -- 'state_transition' | 'plan_created' | 'step_executed' | ...
  detail jsonb,
  created_at timestamptz default now()
);
```

## 4. State Machine

Legal transitions (everything else throws):
```
TRIAGED → PLANNED → AWAITING_APPROVAL → APPROVED → EXECUTING → DONE
PLANNED → REJECTED            (validator failure)
AWAITING_APPROVAL → REJECTED  (human) | EXPIRED (24h timeout)
EXECUTING → FAILED            (step failure after retries; partial results preserved)
```
- Transitions are the ONLY way to mutate `workflows.state` — single `engine.transition(id, event)` function, row-level lock (`select ... for update`), audit entry per transition.
- `EXPIRED` sweep: cron every 15 min.

## 5. Planner Contract

### 5.1 Tool Registry
Each v1 tool gets a registry entry:
```ts
interface ToolDef {
  name: string;                    // 'hubspot.update_contact'
  description: string;
  argsSchema: z.ZodType;           // zod, also exported as JSON Schema into the prompt
  sideEffect: boolean;             // false → may run without approval (reads)
  maxPerPlan: number;              // e.g. email.send: 1
}
```
v2 launch registry: `hubspot.get_contact` (read), `hubspot.update_contact`, `hubspot.create_deal`, `hubspot.add_note`, `email.draft`, `email.send`, `ticket.update`. Nothing else.

### 5.2 Plan Schema
```ts
const PlanStep = z.object({
  tool: z.string(),                // must exist in registry
  args: z.record(z.unknown()),     // validated against that tool's argsSchema
  rationale: z.string().max(300),
  depends_on: z.array(z.number().int()).default([])  // step indices
});
const Plan = z.object({
  goal: z.string().max(300),
  risk_level: z.enum(['low','medium','high']),
  steps: z.array(PlanStep).min(1).max(10),
  human_summary: z.string().max(600)   // shown in approval message
});
```
Planner prompt inputs: trigger payload + RAG-retrieved policy docs (top 4 chunks) + tool registry JSON schemas + hard rules ("never invent entity IDs — use a read step first", "one email.send max", "if information is insufficient, output a plan whose only step is email.draft asking for clarification").

### 5.3 Validator (code, runs after LLM)
Rejects the plan (→ REJECTED, alert) if: unknown tool; args fail the tool's zod schema; `maxPerPlan` exceeded; dependency cycle; any referenced HubSpot ID not present in either the trigger payload or a prior read step's declared output; `risk_level=high` (v2 policy: high-risk always rejected with a note to handle manually).

## 6. Approval Gate
- Notifier posts: `human_summary`, risk level, numbered step list (tool + key args), buttons `[✅ Approve] [❌ Reject]`.
- Slack: Block Kit + interactivity endpoint. Telegram: inline keyboard + callback. One implementation behind `NotifierPort` interface; config `NOTIFIER=slack|telegram`.
- Approver allowlist via env (`APPROVER_IDS`). Non-allowlisted clicks are ignored + audited.
- Approve → `APPROVED`, engine immediately enqueues execution. Reject → `REJECTED`, optional reason captured.
- No plan editing in v2.0 (schema field `edited_args` reserved; editing is a stretch issue).

## 7. Executor
- Sequential execution in `step_index` order, respecting `depends_on`.
- Per step: set `running` → call the v1 tool layer → `succeeded`/`failed`. Retries: 3, exponential backoff (1s/4s/16s), only on network/5xx — never on 4xx.
- **Idempotency:** before running, check `idempotency_key` status; `succeeded` steps are skipped. Re-running the executor on any workflow is always a no-op for completed steps. Test this explicitly.
- Step failure after retries → workflow `FAILED`, remaining steps `skipped`, notifier gets a failure summary with partial results.
- Read-step outputs are appended to an execution context passed to later steps (arg templating: `"{{steps.0.result.contact_id}}"` resolved by executor).

## 8. Security & Config
- New env: `WORKFLOW_MODE, NOTIFIER, APPROVER_IDS, SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET or TELEGRAM_BOT_TOKEN, APPROVAL_TIMEOUT_HOURS=24`
- Verify Slack signatures / Telegram secret token on all callback endpoints.
- Executor runs with the same HubSpot scopes as v1 — no scope expansion in v2.
- LLM guard: max 30 planner calls/hour.

## 9. Non-Goals (v2.0)
- Parallel step execution; plan editing before approval; multi-approver quorum; high-risk plan execution; new HubSpot tools beyond the launch registry; UI dashboard beyond a simple stats endpoint (`GET /stats`).

## 10. Definition of Done
- Fixture email → plan → Slack/Telegram approval → executed against mocked HubSpot → DONE, fully audited.
- Audit log proves zero side-effect tool calls outside APPROVED workflows (test asserts this).
- Executor re-run is a verified no-op.
- Rejected/expired paths tested. `WORKFLOW_MODE=direct` still behaves exactly like v1 (regression suite passes).
- Demo: same trigger run in `direct` vs `gated` mode side by side + 2-min Loom.
