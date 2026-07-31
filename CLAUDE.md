# Recipe Library

Personal recipe-capture + meal-planning tool. Chrome extension saves recipes from web pages,
YouTube, Facebook/Instagram/Threads, and photos; a Claude-powered agent searches the library
and plans meals over chat.

**Status: all original milestones (M0–M8) and the durable asynchronous-ingestion refactor
are complete.** The execution plan is historical record. The refactor's architecture,
job API/schema, worker, atomic persistence, extension handoff, Library lifecycle UI, and
queued end-to-end smoke path have shipped. See `ARCHITECTURE.md`'s “Post-MVP additions”
for the binding design.

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
- Out of scope (do not add): auth/accounts, general-purpose or external job queues, ORMs,
  streaming, WebSockets, conversation persistence, semantic dedup, a `list_tags` tool,
  app Dockerfiles. **Narrow exception:** the approved ingestion refactor may add exactly one
  Postgres-backed `ingestion_jobs` lifecycle and one concurrency-one worker inside the existing
  server process. Do not introduce Redis, BullMQ, a separate worker service, or broaden the
  queue to unrelated work.
- Secrets only in `.env` (gitignored); mirror every var in `.env.example` with a placeholder.
- Anthropic SDK usage must follow `docs/execution-plan.md` Appendix D verbatim.
- TypeScript strict mode; zod-validate all request bodies.

## Durable ingestion boundaries

The binding target design is `ARCHITECTURE.md` → “Durable asynchronous handoff” and
“Ingestion lifecycle.” Preserve these boundaries while implementing it:

- Extension web/YouTube saves persist a job and receive `202` before long-running extraction.
- The extension background service worker performs delivery only; Claude/Voyage work runs in
  the server worker from the stored input.
- Facebook/Instagram/Threads retain expand → preview → explicit confirmation, then enqueue.
  Do not redesign social confirmation until the queue is stable.
- Photo upload and bookmark bulk import remain synchronous in the first release.
- Incomplete/failed captures live in `ingestion_jobs`, never as placeholder `recipes` rows.
- One captured source may map to multiple recipes through `ingestion_job_recipes`.
- Worker concurrency is one; claims are atomic; interrupted jobs recover on server startup.
- Multi-recipe persistence is atomic. A failed job must not leave a partially saved set.
- Failed jobs retain captured input for manual Retry/Dismiss. Successful jobs clear HTML.
- Library progress uses visibility-aware polling only; do not add streaming or WebSockets.

`docs/execution-plan.md` remains unchanged as a historical record. Its synchronous-ingestion
and no-job-queue rules are superseded only by the narrow exception above.

Dependency maintenance completed 2026-07-31: the transitive `body-parser` resolution is at
least 1.20.6 and PostCSS is at least 8.5.18; the resulting npm audit is clean.

Also deferred from the M5 manual click-through: improve the error experience when a photo
upload does not contain a recipe. Keep photo ingestion synchronous; this is a focused validation/
messaging issue, not part of the durable extension-ingestion queue.

## Commands (once scaffolded, M0+)

- `brew services start postgresql@18` — Postgres (pgvector installed via brew; no Docker in this project)
- `npm run migrate` — apply `server/db/migrations/*.sql` in order
- `npm run smoke` — end-to-end fixture ingest against a running server (self-cleaning)
- `npm run dev:server` / `npm run dev:web` — dev servers
- `npm test` — vitest
