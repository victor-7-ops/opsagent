# SPEC.md — OpsAgent

## 1. Project Summary

OpsAgent is an AI-powered business operations automation suite that deploys autonomous
agents to handle CRM lead management and client support ticket workflows — the two
highest-leverage, highest-volume categories of manual ops work in a sales/service
organization.

It is a portfolio project purpose-built to demonstrate production-grade competency in:
Node.js/TypeScript backend engineering, OAuth-based third-party API integration,
CRM automation, AI agent orchestration (Claude API + OpenClaw), n8n workflow
automation, Docker/Linux deployment, and lightweight RAG knowledge retrieval.

It follows the same architectural discipline as `procurement-agent`: two discrete,
production-shaped workflows, orchestrated by autonomous Claude-based agents, with a
thin automation layer (n8n) handling triggers/webhooks and a mission-control view for
oversight.

## 2. Problem Statement

Sales and client-service teams lose significant hours per week on repetitive,
rules-based work: routing leads, drafting follow-ups, triaging support tickets,
escalating SLA risks, and producing status reports. This work is high-volume,
low-complexity-per-instance, and well-suited to AI agents — but most SMB tooling
(HubSpot workflows, Zapier) is either too rigid (fixed if/then trees) or too
disconnected from natural-language judgment calls (e.g., "is this complaint
legitimate?", "how urgent is this ticket?").

OpsAgent demonstrates how an LLM-based agent layer can sit on top of a CRM and
support inbox to make judgment-based automation decisions, while a deterministic
automation layer (n8n) handles the reliable plumbing (triggers, retries, logging).

## 3. Goals

- Build two complete, working, demoable workflows (not stubs):
  1. Lead Routing & Follow-Up Agent
  2. Client Ticket / Escalation Agent
- Use Node.js/TypeScript as the primary backend language (portfolio gap-closer)
- Integrate a real CRM via OAuth (HubSpot, free developer account/sandbox)
- Use Claude API (Anthropic) + OpenClaw for agent orchestration and decision-making
- Use n8n as the deterministic automation/orchestration layer
- Add a lightweight RAG knowledge base (ChromaDB or Pinecone free tier) for the
  ticket agent to answer common questions from a small docs corpus
- Deploy to a Linux VPS via Docker (reuse existing Oracle Cloud / DigitalOcean setup)
- Ship a minimal HTML/CSS reporting dashboard (KPI + activity feed)
- Document everything spec-first, matching existing repo conventions

## 4. Non-Goals (v1)

- Multi-tenant / multi-org support (single sandbox org is fine)
- Production-grade auth/user management beyond what OAuth requires
- Full CRM feature parity — this is a demonstration of automation patterns, not a
  CRM replacement
- Mobile UI
- Payment/billing integration
- Handling real production client data (use HubSpot sandbox + synthetic test data)

## 5. Users / Personas

- **Sales Rep** — receives auto-routed, auto-qualified leads with drafted follow-ups
  ready to send/approve
- **Client Services Agent** — receives triaged tickets with severity/classification
  and a drafted response ready for review
- **Ops Manager** — views the dashboard for KPI/activity oversight, escalation logs

## 6. Core Workflows

### 6.1 Flow 1 — Lead Routing & Follow-Up Agent

**Trigger:** New lead created in HubSpot (webhook) OR deal stage changes to a
tracked stage (e.g., "Closed Won").

**Pipeline:**
1. n8n receives HubSpot webhook (new contact/deal created, or deal stage change)
2. n8n calls OpsAgent backend `/webhooks/hubspot/lead`
3. Claude-based agent (via OpenClaw) evaluates the lead:
   - Qualifies/scores based on available fields (company size, source, notes)
   - Selects assignee via round-robin logic (deterministic, not LLM-decided)
   - Drafts a personalized first-touch follow-up email
4. On deal-stage change to "Closed Won":
   - Agent schedules a delayed follow-up (n8n Wait node, 3 days)
   - Re-checks deal state before sending (guards against stage having changed again)
   - Drafts and sends/queues a check-in email
5. All actions logged to Postgres/SQLite for the dashboard and audit trail
6. Failure handling: failed HubSpot API calls retried with backoff (n8n built-in);
   persistent failures alert via Telegram (reuse existing bot pattern from
   `actions-monitoring`)

**Key demo moment:** the exact "3 days after Closed Won → follow-up email" scenario
from the job's Automation Design Challenge question — but as working, deployed code.

### 6.2 Flow 2 — Client Ticket / Escalation Agent

**Trigger:** New support ticket (simulate via webhook — HubSpot ticket API or a
simple form/email-parse endpoint).

**Pipeline:**
1. Ticket received → OpsAgent backend `/webhooks/ticket`
2. Claude agent classifies:
   - Severity (low / medium / high / SLA-risk)
   - Category (complaint, question, billing, service issue)
   - Complaint validity signal (flags likely-frivolous vs. legitimate)
3. If classified as a common/FAQ-type question: agent queries the RAG knowledge
   base (ChromaDB) built from a small synthetic docs corpus, drafts a direct
   customer-facing response
4. If high severity or SLA-risk: agent flags for escalation, notifies via Telegram/
   dashboard alert, does NOT auto-send
5. All tickets + classifications + response drafts logged for dashboard view
6. SLA monitor: a scheduled n8n job checks open tickets against SLA thresholds and
   raises alerts on breach risk

**Key demo moment:** shows judgment-based triage (not just fixed rules) plus a
working RAG retrieval path — hits both the "AI Agents" and "Vector Databases/RAG"
preferred-skills lines from the JD directly.

## 7. Architecture

```
                         ┌─────────────────┐
   HubSpot (OAuth) ─────▶│   n8n (webhooks, │
   Ticket source ───────▶│   retries, delay,│
                         │   scheduling)     │
                         └────────┬─────────┘
                                  │ HTTP
                         ┌────────▼─────────┐
                         │  OpsAgent API     │
                         │  Node.js/Express  │
                         │  (TypeScript)     │
                         └────────┬─────────┘
                                  │
                  ┌───────────────┼───────────────┐
                  ▼               ▼               ▼
          ┌───────────────┐ ┌───────────┐ ┌───────────────┐
          │ OpenClaw       │ │ ChromaDB  │ │ Postgres/      │
          │ (Claude agent  │ │ (RAG      │ │ SQLite         │
          │ orchestration) │ │ knowledge)│ │ (state, logs)  │
          └───────────────┘ └───────────┘ └───────────────┘
                                  │
                         ┌────────▼─────────┐
                         │ HTML/CSS          │
                         │ Dashboard          │
                         │ (KPIs, activity)   │
                         └───────────────────┘
```

All backend services containerized via Docker Compose; deployed to a Linux VPS
(Ubuntu) over SSH, matching the JD's infra requirements directly.

## 8. Tech Stack (mapped to JD requirements)

| Requirement (JD)                     | OpsAgent Implementation                          |
|---------------------------------------|---------------------------------------------------|
| Node.js / JavaScript (2+ yrs signal)  | Full backend in Node.js + TypeScript              |
| Linux servers (Ubuntu), SSH           | Deployed to Ubuntu VPS via SSH                    |
| Docker                                | Docker Compose for all services                   |
| REST APIs, webhooks, OAuth            | HubSpot OAuth2 flow, webhook receivers             |
| Google Workspace APIs                 | Optional: Google Meet/Calendar stub for tickets    |
| CRM / email automation                | HubSpot lead + deal workflows                      |
| AI agent frameworks (OpenClaw, etc.)  | OpenClaw + Claude API (Anthropic)                  |
| Prompt engineering                    | Structured prompts for scoring/classification      |
| Vector DBs / RAG                      | ChromaDB knowledge base for ticket agent           |
| HTML/CSS dashboards                   | Lightweight reporting dashboard                    |
| n8n / Make / Zapier                   | n8n as orchestration/automation layer              |
| Business process automation           | Both flows are BPA by definition                   |

## 9. Data Model (minimal)

- `leads` — id, hubspot_id, status, assigned_to, score, created_at
- `deals` — id, hubspot_id, stage, last_stage_change_at, followup_sent_at
- `tickets` — id, source, severity, category, validity_flag, response_draft, status
- `activity_log` — id, type, ref_id, payload, created_at
- `sla_alerts` — id, ticket_id, breached_at, notified_at

**Migration tool:** Prisma (schema-first, TS-native, matches Node/TS backend stack).

## 10. Success Criteria

- Both flows run end-to-end against a live HubSpot sandbox with real webhook triggers
- Agent decisions (routing, classification, drafts) are logged and inspectable
- Dashboard shows real activity from at least one full test run per flow
- Fully Dockerized, deployed, and reachable via a public URL for demo purposes
- README frames the project explicitly in "AI teammates for sales/client ops"
  language, with a short GIF/demo walkthrough
- Repo includes this SPEC.md, CLAUDE.md, and BUILDPLAN.md following existing
  documentation conventions

## 11. Out of Scope for Demo Video

The project should be far enough along by the time of the Sourvey application video
that Flow 1 (Lead Routing) is fully working end-to-end — this becomes the "Project
Walkthrough" video answer. Flow 2 can be in-progress if time is tight; a partial
working demo is still stronger than a from-scratch on-camera build.
