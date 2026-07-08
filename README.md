# Recipe Library

Personal recipe-capture and meal-planning tool. A Chrome extension saves recipes
from any web page or YouTube video into a structured Postgres library; a
Claude-powered agent searches it, plans meals, and builds grocery lists over chat.

- **Design:** [`ARCHITECTURE.md`](ARCHITECTURE.md) (styled: [`docs/architecture.html`](docs/architecture.html))
- **Build history:** [`docs/execution-plan.md`](docs/execution-plan.md) — milestones M0–M8, all complete

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
   (keep the popup open ~15 s while it extracts)

See [`extension/README.md`](extension/README.md) for details.

## Verify

```sh
npm test                  # unit tests (URL identity, JSON-LD, grocery scaling)
npm run smoke             # end-to-end: ingests a fixture through the running
                          # server, asserts the row, cleans up (needs dev:server up)
```

## Layout

```
server/     Express API — ingestion pipeline, agent + tools, REST routes
extension/  Chrome MV3 capture extension (esbuild)
web/        Vite + React chat/library/settings UI
docs/       architecture reference + execution plan
```
