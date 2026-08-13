# Recipe Library

Personal recipe-capture and meal-planning tool. A Chrome extension saves recipes
from web pages, YouTube videos, Facebook/Instagram/Threads posts, or a photo of a
cookbook page into a structured Postgres library; a Claude-powered agent searches
it, plans meals, and builds grocery lists over chat.

- **Design:** [`ARCHITECTURE.md`](ARCHITECTURE.md) (styled: [`docs/architecture.html`](docs/architecture.html))
- **Build history:** [`docs/execution-plan.md`](docs/execution-plan.md) — milestones M0–M8, plus
  post-MVP additions documented inline in `ARCHITECTURE.md`

## Features

- **Capture from anywhere:** any recipe web page, a YouTube video (title/description/
  transcript), a Facebook/Instagram/Threads post, or a photo of a cookbook page/recipe
  card via Claude's vision. A single source can yield more than one recipe (e.g. a
  page with two recipes, or a video that walks through several dishes) and each
  becomes its own library entry.
- **Chat agent:** search your library, plan meals, and build a consolidated grocery
  list over conversation. Also manages a pantry-staples list so recurring basics
  (salt, oil, etc.) get left off grocery lists automatically.
- **Library UI:** browse, search/filter by tag or ingredient, edit meal plans, and
  check off a grocery list.
- **Optional:** push a grocery list to Apple Reminders (macOS-only, via AppleScript —
  see [Optional: Apple Reminders](#optional-apple-reminders) below) and bulk-import
  recipes from a Chrome bookmarks export.

## Scope & security

Built for **single-user, local use** — there's no auth/accounts system by design, and
the extension talks to the server with one shared secret (`INGEST_API_KEY`), not
per-user credentials. That's an intentional, appropriate tradeoff for running this on
your own machine; it is **not** hardened for multi-user or public-internet deployment
as-is. If you want to run this somewhere reachable by other people, you'd need to add
real authentication first.

## Prerequisites

- macOS with [Homebrew](https://brew.sh), Node 20+, Chrome
- API keys (all with generous free tiers):

| Key | Where to get it | Used for |
|---|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/settings/keys) | recipe extraction + the chat agent |
| `VOYAGE_API_KEY` | [dashboard.voyageai.com](https://dashboard.voyageai.com) | embeddings for semantic search (200M free tokens) |
| `YOUTUBE_API_KEY` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → enable *YouTube Data API v3* → API key | video title/description |
| `INGEST_API_KEY` | invent one: `openssl rand -hex 24` | shared secret between extension and server |

> **Voyage note:** without a payment method on file, Voyage caps at **3 requests/min**,
> which chat can exceed in a single turn. Search degrades gracefully (filters +
> recency ordering) when that happens; adding a card to your Voyage account lifts
> the cap and still costs nothing until the free tokens are exhausted.

## Setup (from scratch)

```sh
# 1. Database — native Postgres 18 + pgvector, no Docker
brew install postgresql@18 pgvector
brew services start postgresql@18
export PATH="$(brew --prefix postgresql@18)/bin:$PATH"   # postgresql@18 is keg-only
createdb recipes

# 2. Configuration
cp .env.example .env      # then fill in the keys above

# 3. Install + migrate
npm install
npm run migrate           # creates all tables + seeds tags/pantry staples
```

## Run

```sh
npm run dev:server        # API on http://localhost:3001
npm run dev:web           # web app on http://localhost:5173 (proxies /api)
```

## Chrome extension (one-time)

```sh
npm run build --workspace extension
```

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/dist`
2. Right-click the icon → **Options** → set API base (`http://localhost:3001`) and your `INGEST_API_KEY`
3. Open any recipe page or YouTube cooking video → click the icon → **Save recipe**
4. Once the popup says **Queued ✓**, you can close it or navigate away; the local server
   continues extraction in the background.

**Facebook/Instagram/Threads:** the popup shows a preview of what it found (the
detected recipe title(s)) and waits for you to confirm before saving —
these apps hydrate post content asynchronously in ways that make a one-shot capture
unreliable, so the preview step is a deliberate safety check, not an extra step you
can skip. Keep the popup open while that preview is generated. **Facebook** then saves the
confirmed snapshot synchronously using its pre-queue compatibility path; Instagram and
Threads reuse the confirmed extraction before their background handoff. If you just navigated from one post
straight to another in the same tab, refresh the page (⌘R) before clicking Save.

**Photo of a recipe** (cookbook page, handwritten card, screenshot): use **"+ Add
from photo"** in the Library tab of the web app instead of the extension — it goes
through Claude's vision rather than page capture. A single photo with more than one
recipe on it (e.g. two recipes on one cookbook page) is split into separate entries.
Images without visible recipe text are rejected without saving a file or library row;
the Library prompts you to try a clearer photo with ingredients or instructions.

See [`extension/README.md`](extension/README.md) for details.

## Optional: Apple Reminders

Push an unchecked grocery list to Apple Reminders (syncs to your phone via iCloud —
no accounts or API needed) via a button in the web app's grocery list view. **macOS
only** — it shells out to Reminders.app through AppleScript (`server/src/reminders.ts`),
so this silently does nothing useful on Linux/Windows. First use triggers a macOS
automation-permission prompt (approve it in **System Settings → Privacy & Security →
Automation**); each plan gets its own named Reminders list so multiple plans coexist.

## Optional: bulk-import from Chrome bookmarks

If you already have recipes saved as browser bookmarks, `npm run import-bookmarks --
<bookmarks.html> "<Folder Name>"` (export via `chrome://bookmarks` → ⋮ → Export
bookmarks) ingests every link in that folder directly through the pipeline, reporting
which pages need a manual extension-save because they're bot-walled server-side. See
`server/scripts/bulk-import-bookmarks.ts` for flags (`--dry-run`, `--limit`, `--skip`).

## Verify

```sh
npm test                  # unit tests (URL identity, JSON-LD, grocery scaling)
npm run smoke             # end-to-end: queues a captured fixture through the running
                          # worker, verifies lifecycle + recipe, then cleans up
                          # (needs dev:server up and costs one enrichment/embedding)
```

## Layout

```
server/     Express API — ingestion pipeline, agent + tools, REST routes
extension/  Chrome MV3 capture extension (esbuild)
web/        Vite + React chat/library/settings UI
docs/       architecture reference + execution plan
```
