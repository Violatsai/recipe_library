# Recipe Library

Personal recipe-capture + meal-planning tool. Chrome extension saves recipes from web pages
and YouTube; a Claude-powered agent searches the library and plans meals over chat.

## Read before working

1. **`ARCHITECTURE.md`** — the design. All decisions are settled there (see "Settled
   decisions" table). Do not redesign.
2. **`docs/execution-plan.md`** — the build script. Work **one milestone at a time, in
   order**; each ends with its verification checks, a single commit (message given in the
   plan), and a push.

## Hard rules

- If the plan is ambiguous, contradicts the architecture doc, or something fails in a way
  the plan doesn't cover: **stop and ask the user**. Never improvise schema changes, new
  dependencies, or layout changes.
- Out of scope (do not add): auth/accounts, job queues, ORMs, streaming, WebSockets,
  conversation persistence, semantic dedup, a `list_tags` tool, app Dockerfiles.
- Secrets only in `.env` (gitignored); mirror every var in `.env.example` with a placeholder.
- Anthropic SDK usage must follow `docs/execution-plan.md` Appendix D verbatim.
- TypeScript strict mode; zod-validate all request bodies.

## Commands (once scaffolded, M0+)

- `docker compose up -d` — Postgres (pgvector)
- `npm run migrate` — apply `server/db/migrations/*.sql` in order
- `npm run dev:server` / `npm run dev:web` — dev servers
- `npm test` — vitest
