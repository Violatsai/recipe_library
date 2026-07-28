# Recipe Library

Personal recipe-capture + meal-planning tool. Chrome extension saves recipes from web pages,
YouTube, Facebook/Instagram/Threads, and photos; a Claude-powered agent searches the library
and plans meals over chat.

**Status: all milestones (M0–M8) complete.** The execution plan is historical record;
work from here is normal feature/fix development — see `ARCHITECTURE.md`'s
"Post-MVP additions" for what's shipped since.

## Read before working

1. **`ARCHITECTURE.md`** — the design. All decisions are settled there (see "Settled
   decisions" table; see "Post-MVP additions" for what shipped after M0–M8). Do not
   redesign without discussing with the user.
2. **`docs/execution-plan.md`** — the build script the MVP was built from (M0–M8, done).
   Useful as a map of what exists and why; deviations are recorded inline.
3. **`README.md`** — setup + commands.

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

- `brew services start postgresql@18` — Postgres (pgvector installed via brew; no Docker in this project)
- `npm run migrate` — apply `server/db/migrations/*.sql` in order
- `npm run smoke` — end-to-end fixture ingest against a running server (self-cleaning)
- `npm run dev:server` / `npm run dev:web` — dev servers
- `npm test` — vitest
