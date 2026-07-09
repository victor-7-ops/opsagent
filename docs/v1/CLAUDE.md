# CLAUDE.md — OpsAgent

## Purpose of this file

This file tells Claude Code how to work in this repo. Read this before starting any
issue. Also read `SPEC.md` for full project context and `BUILDPLAN.md` for the
current issue queue.

## Working agreement

- **Spec-first.** Do not write implementation code for a feature that isn't
  described in SPEC.md or a BUILDPLAN.md issue. If a task requires a decision not
  covered by the spec, stop and ask rather than assuming.
- **One issue per session.** Work the single atomic issue assigned. Do not
  scope-creep into adjacent issues even if the code is "right there."
- **TypeScript throughout the backend.** Node.js + Express + TypeScript. No
  vanilla JS in `/src`. Strict mode on.
- **Docker-first.** Every service must run via `docker-compose up` locally before
  it's considered done. Do not leave a feature working only via bare `npm run dev`.
- **Real integrations over mocks where feasible.** Use a real HubSpot developer
  sandbox account and real (test) API calls rather than fully mocked responses,
  except in unit tests. Mocked webhook payloads are fine for local dev; the
  end-to-end demo must hit real HubSpot.
- **Log everything agent-decided.** Any decision made by the Claude agent
  (routing, classification, scoring, drafted content) must be persisted to
  `activity_log` with enough context to reconstruct why the decision was made.
- **Small, reviewable commits.** One logical change per commit. Commit messages
  reference the BUILDPLAN issue number.

## Repo structure (target)

```
opsagent/
├── SPEC.md
├── CLAUDE.md
├── BUILDPLAN.md
├── docker-compose.yml
├── backend/
│   ├── src/
│   │   ├── routes/          # webhook receivers, API endpoints
│   │   ├── agents/          # Claude/OpenClaw agent logic
│   │   ├── integrations/    # HubSpot OAuth + API client
│   │   ├── rag/             # ChromaDB ingestion + query
│   │   ├── db/              # models, migrations
│   │   └── index.ts
│   ├── package.json
│   └── Dockerfile
├── n8n/
│   └── workflows/           # exported n8n workflow JSON
├── dashboard/
│   ├── index.html
│   └── (vanilla or lightweight framework, matches JD's "HTML dashboards")
└── docs/
    └── demo-corpus/         # synthetic FAQ docs for RAG ingestion
```

## Environment / secrets

- All secrets (HubSpot client ID/secret, Anthropic API key, Telegram bot token) go
  in `.env`, never committed. `.env.example` must stay up to date whenever a new
  var is introduced.
- HubSpot: use a free developer test account + sandbox, not a real business's data.
- Use synthetic/fake lead and ticket data for all testing.

## Definition of done (per issue)

An issue is not done until:
1. Code runs via Docker Compose
2. Relevant activity is logged and visible in the dashboard or DB
3. README/SPEC updated if behavior diverges from what was originally scoped
4. No secrets or real customer data committed

## Things to flag to the human, not guess at

- Any HubSpot API scope/permission decision
- Any choice between ChromaDB vs. Pinecone if not already decided in SPEC.md
- Whether agent-drafted emails should ever auto-send vs. always require approval
  (default assumption: draft-only, human sends, unless an issue explicitly says
  otherwise)
- Production deployment target/domain (VPS provider, DNS) if not yet decided
