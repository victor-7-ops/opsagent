# BUILDPLAN.md — OpsAgent

Atomic, one-issue-per-session breakdown. Work top to bottom within a phase; phases
can be reordered if a dependency blocks progress. Each issue should be completable
in a single focused Claude Code session.

---

## Phase 0 — Foundation

### Issue 01: Repo scaffold & Docker Compose skeleton
- Initialize `backend/` as a Node.js + TypeScript + Express project (strict mode)
- Add `docker-compose.yml` with services: `backend`, `postgres`, `n8n` (empty/stub
  containers are fine at this stage — just needs to boot)
- Add `.env.example` with placeholder vars for HubSpot, Anthropic, Telegram, DB
- Add basic health-check endpoint (`GET /health`)
- **Done when:** `docker-compose up` boots all services with no errors, `/health`
  returns 200

### Issue 02: Database schema & migrations
- Implement the data model from SPEC.md §9 (`leads`, `deals`, `tickets`,
  `activity_log`, `sla_alerts`) using a migration tool (e.g., Prisma or
  node-pg-migrate — pick one and note the choice in SPEC.md)
- **Done when:** migrations run cleanly against the Postgres container, schema
  matches SPEC.md

### Issue 03: HubSpot OAuth flow
- Implement OAuth2 authorization + token exchange + refresh for a HubSpot
  developer sandbox app
- Store tokens securely (encrypted at rest or at minimum out of logs/version
  control)
- Add a manual test route to confirm a valid HubSpot API call works post-auth
- **Done when:** can authenticate against a real HubSpot sandbox and fetch a
  contact via API

---

## Phase 1 — Flow 1: Lead Routing & Follow-Up Agent

### Issue 04: HubSpot webhook receiver (new lead)
- Endpoint to receive HubSpot "contact created" webhook
- Validate payload, persist raw lead to `leads` table (status: `received`)
- **Done when:** creating a test contact in HubSpot sandbox triggers a row in
  `leads`

### Issue 05: Claude agent — lead scoring & round-robin assignment
- Implement agent logic (via Anthropic API, optionally through OpenClaw) that
  scores a lead from available fields and assigns via deterministic round-robin
- Log the decision + reasoning to `activity_log`
- **Done when:** a test lead gets scored and assigned, with a readable log entry
  explaining why

### Issue 06: Follow-up email drafting
- Agent drafts a personalized first-touch email based on lead data
- Store as draft (do NOT auto-send — see CLAUDE.md default assumption)
- **Done when:** draft is generated and stored, retrievable via API/dashboard

### Issue 07: Deal-stage webhook + delayed follow-up (n8n)
- n8n workflow: listen for HubSpot deal-stage-change webhook → filter for
  "Closed Won" → Wait 3 days → re-check deal state → call backend to draft
  check-in email
- Export the n8n workflow JSON into `n8n/workflows/`
- **Done when:** manually triggering a stage change in sandbox results in a
  scheduled, verifiable follow-up job (can shortcut the wait to minutes for
  testing, documented in the workflow)

### Issue 08: Failure handling & Telegram alerting for Flow 1
- n8n retry/backoff on HubSpot API failures
- Telegram alert on persistent failure (reuse bot pattern from
  `actions-monitoring` repo if convenient)
- **Done when:** a simulated failure (e.g., invalid token) triggers a Telegram
  alert within the expected window

---

## Phase 2 — Flow 2: Client Ticket / Escalation Agent

### Issue 09: Ticket intake endpoint
- Webhook/API endpoint to receive a new ticket (HubSpot ticket API or simple
  synthetic form/email-parse endpoint — choose the simpler path and note it)
- Persist to `tickets` table
- **Done when:** a test ticket submission creates a row with status `received`

### Issue 10: Claude agent — severity/category classification
- Agent classifies severity, category, and validity signal
- Log decision + reasoning to `activity_log`
- **Done when:** test tickets across a few synthetic scenarios (billing question,
  angry complaint, vague message) get sensible, distinct classifications

### Issue 11: RAG knowledge base setup (ChromaDB)
- Stand up ChromaDB (containerized)
- Write ingestion script for a small synthetic FAQ/docs corpus (`docs/demo-corpus/`)
- **Done when:** a test query against the corpus returns relevant chunks

### Issue 12: RAG-backed response drafting for FAQ-type tickets
- For tickets classified as common/FAQ-type, agent queries ChromaDB and drafts a
  direct customer-facing response
- Store as draft, not auto-sent
- **Done when:** a synthetic FAQ ticket produces a relevant, correct draft response

### Issue 13: Escalation flagging for high-severity/SLA-risk tickets
- High-severity or SLA-risk tickets get flagged (not auto-responded), notification
  sent (Telegram/dashboard)
- **Done when:** a synthetic high-severity ticket triggers a visible escalation
  flag and notification

### Issue 14: SLA monitor (scheduled n8n job)
- Scheduled job checks open tickets against SLA thresholds, raises alert on
  breach risk
- **Done when:** an artificially aged test ticket triggers an SLA alert

---

## Phase 3 — Dashboard & Polish

### Issue 15: HTML/CSS reporting dashboard — activity feed
- Simple dashboard showing recent activity_log entries (leads routed, tickets
  classified, escalations, follow-ups sent)
- **Done when:** dashboard reflects real data from both flows after a test run

### Issue 16: HTML/CSS reporting dashboard — KPI summary
- Add summary stats: leads routed today/week, avg response time, tickets by
  severity, SLA breaches
- **Done when:** KPIs update correctly against seeded/test data

### Issue 17: README + demo framing
- Write README explicitly framing the project as "AI teammates for sales/client
  ops," matching the language style of the target job posting
- Include architecture diagram (reuse SPEC.md §7), setup instructions, and a
  short GIF/screen recording of both flows running
- **Done when:** a stranger could read the README and understand what OpsAgent
  does and why it exists in under 2 minutes

### Issue 18: Deployment — Docker + Linux VPS
- Deploy full stack to a Linux VPS (Ubuntu) via Docker Compose over SSH
- Confirm webhooks reachable publicly (domain or IP + reverse proxy/Nginx)
- **Done when:** the live demo URL works end-to-end from a HubSpot sandbox
  webhook through to dashboard visibility

---

## Suggested cut line if time-constrained before the application deadline

If Flow 1 (Issues 01–08) is fully working end-to-end with a deployed dashboard,
that alone is a strong, demoable project for the video walkthrough. Flow 2
(RAG/ticket agent) is the "nice to have" that pushes this from "good fit" to
"exceptional fit" — prioritize accordingly if time runs short.
