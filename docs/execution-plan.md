# Execution Plan — Recipe Library

This document is an implementation script for the design in [`ARCHITECTURE.md`](../ARCHITECTURE.md).
It is written to be executed **one milestone at a time** by a coding agent. All design decisions
are already made — the executor's job is faithful implementation, not redesign.

## How to use this document

1. Read `ARCHITECTURE.md` fully, then this file, before writing any code.
2. Execute milestones **in order** (M0 → M8). Do not start a milestone until the previous
   one's **Done when** checks pass.
3. End every milestone with a single git commit using the given message, and push.
4. If something in this plan is ambiguous, contradicts `ARCHITECTURE.md`, or fails in a way
   the plan doesn't anticipate: **stop and ask the user.** Do not improvise schema changes,
   add dependencies not listed here, or restructure the layout.

## Ground rules for the executor

- **Do not add:** user auth/accounts, job queues, ORMs, response streaming, WebSockets,
  conversation persistence, a `list_tags` tool, semantic dedup, Dockerfiles for the apps.
  These are all deliberately out of scope (see ARCHITECTURE.md → Deferred).
- **Secrets** live in `.env` (gitignored). Every new variable also goes in `.env.example`
  with a placeholder. Never commit a real key.
- TypeScript `strict: true` everywhere. Validate all HTTP request bodies with `zod`.
- Keep modules small and single-purpose; follow the repo layout below exactly.
- When calling the Anthropic SDK, use the exact patterns in Appendix D — do not invent
  API shapes from memory.

## Pinned stack (do not revisit)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript everywhere (server, extension, web) | per ARCHITECTURE.md stack lean |
| Server | Node 20+, Express 4 | plain REST, JSON only |
| DB | Postgres 16 + pgvector via `docker-compose` (`pgvector/pgvector:pg16`) | swap to hosted later = change `DATABASE_URL` only |
| DB access | raw SQL via `pg` | no ORM |
| Migrations | plain `.sql` files in `server/db/migrations/`, applied in filename order by a small runner script, tracked in a `schema_migrations` table | |
| Validation | `zod` | shared where convenient |
| LLM (enrichment) | Anthropic `claude-sonnet-5`, structured outputs via `client.messages.parse` | revisit-later note: try `claude-haiku-4-5` for cost once accuracy is baselined |
| LLM (agent) | Anthropic `claude-sonnet-5`, tool loop via `client.beta.messages.toolRunner` + `betaZodTool` | |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dims — matches `vector(1536)`) | isolated in one module (`embed.ts`) so the provider is swappable |
| Article extraction | `@mozilla/readability` + `jsdom` | for pages without JSON-LD |
| YouTube metadata | YouTube Data API v3 (title, description) | official, free API key |
| YouTube transcripts | `youtube-transcript` npm | unofficial, **best-effort**: always wrapped in try/catch, failure is not an error |
| Extension | Chrome MV3, plain TS bundled with `esbuild` | no framework |
| Web UI | Vite + React + TS | single-page chat app |
| Tests | `vitest`, targeted (URL normalization, JSON-LD parsing, grocery scaling) | not exhaustive coverage |

## Deliberate deviations from ARCHITECTURE.md (already approved)

1. **Ingestion is synchronous**, not an async worker. Single user; a 5–15 s request is fine.
   The extension shows a spinner until the response arrives.
2. **The "web_fetch" of a linked page is a plain server-side HTTP fetch**, not Claude's
   web_fetch tool. Same role in the decision tree, simpler and cheaper. If the fetch is
   bot-blocked, the API returns `422 { error: "NEEDS_HTML" }` and the client retries with HTML.
3. **Additive schema fields:** `recipes.extraction_partial bool default false` (graceful
   partial saves per the risks section) and `recipes.updated_at`.

## Target repo layout

```
recipe_library/
├─ package.json                 # npm workspaces: server, extension, web
├─ docker-compose.yml           # postgres w/ pgvector
├─ .env.example
├─ server/
│  ├─ package.json
│  ├─ db/migrations/            # 001_init.sql, 002_seed.sql, ...
│  ├─ scripts/migrate.ts        # migration runner
│  └─ src/
│     ├─ index.ts               # express app, mounts routes
│     ├─ config.ts              # env loading + validation
│     ├─ db.ts                  # pg pool, query helper, tx helper
│     ├─ ingest/
│     │  ├─ normalizeUrl.ts     # canonicalize + strip tracking params
│     │  ├─ fetchPage.ts        # server-side fetch → html | NEEDS_HTML
│     │  ├─ jsonld.ts           # find schema.org/Recipe (incl. @graph)
│     │  ├─ readable.ts         # readability text extraction
│     │  ├─ youtube.ts          # videoId, Data API, link-in-description, transcript
│     │  ├─ enrich.ts           # the single Claude enrichment pass
│     │  ├─ embed.ts            # embedding provider (isolated)
│     │  └─ pipeline.ts         # orchestrates: source → enrich → embed → upsert tx
│     ├─ agent/
│     │  ├─ systemPrompt.ts     # builds prompt: persona + tag vocab + staples + rules
│     │  ├─ tools.ts            # 6 betaZodTool definitions
│     │  ├─ search.ts           # hybrid search SQL (Appendix B)
│     │  └─ aliases.ts          # ALLERGEN_ALIASES map (Appendix C)
│     └─ routes/
│        ├─ ingest.ts           # POST /api/ingest (key-gated)
│        ├─ chat.ts             # POST /api/chat
│        ├─ recipes.ts          # GET /api/recipes, GET /api/recipes/:id
│        ├─ tags.ts             # tag CRUD + merge
│        ├─ pantry.ts           # pantry staples CRUD
│        └─ grocery.ts          # PATCH /api/grocery-items/:id (checked)
├─ extension/
│  ├─ manifest.json
│  ├─ build.mjs                 # esbuild script
│  └─ src/ (popup.html, popup.ts, options.html, options.ts)
└─ web/                         # Vite React app
```

## Environment variables

| Var | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | server | `postgres://recipe:recipe@localhost:5432/recipes` |
| `ANTHROPIC_API_KEY` | server | enrichment + agent |
| `OPENAI_API_KEY` | server | embeddings only |
| `YOUTUBE_API_KEY` | server | Data API v3 |
| `INGEST_API_KEY` | server + extension | static shared secret for POST /api/ingest |
| `PORT` | server | default 3001 |

---

## M0 — Scaffold & infrastructure

**Goal:** monorepo skeleton, database container, server that boots and can reach the DB.

Steps:
1. Root `package.json` with npm workspaces `["server", "extension", "web"]`; root `.gitignore`
   (node_modules, dist, .env, *.local), `.env.example` with all vars above.
2. `docker-compose.yml`: service `db`, image `pgvector/pgvector:pg16`, env
   `POSTGRES_USER=recipe POSTGRES_PASSWORD=recipe POSTGRES_DB=recipes`, port `5432:5432`,
   named volume.
3. `server` workspace: express, pg, zod, dotenv, tsx (dev runner), typescript, vitest.
   `src/index.ts` with `GET /health` → `{ ok: true, db: <SELECT 1 works> }`.
   `src/config.ts` fails fast with a clear message when a required env var is missing.
4. Root scripts: `dev:server`, `migrate`, `test`.

**Done when:** `docker compose up -d` then `npm run dev:server` then
`curl localhost:3001/health` → `{"ok":true,"db":true}`.

**Commit:** `M0: scaffold monorepo, docker postgres, server skeleton`

---

## M1 — Database schema & seeds

**Goal:** full schema from ARCHITECTURE.md §02, plus seeds.

Steps:
1. `scripts/migrate.ts`: creates `schema_migrations(filename text pk, applied_at timestamptz)`,
   applies unapplied `db/migrations/*.sql` in sorted order, each in a transaction.
2. `001_init.sql` — exactly the ARCHITECTURE.md schema, plus the approved additions:
   - `CREATE EXTENSION IF NOT EXISTS vector;`
   - `recipes` (all fields; `source_url text UNIQUE NOT NULL`; `embedding vector(1536)`;
     `extraction_partial bool NOT NULL DEFAULT false`; `updated_at timestamptz NOT NULL DEFAULT now()`)
   - `ingredients`, `tag_categories`, `tags` (with `status text NOT NULL DEFAULT 'approved'`,
     `UNIQUE(category, value)`), `recipe_tags`, `meal_plans`, `meal_plan_recipes`,
     `grocery_lists`, `grocery_items`, `pantry_staples`
   - index: `CREATE INDEX ON recipes USING hnsw (embedding vector_cosine_ops);`
3. `002_seed.sql` — seed data from Appendix C (tag categories, starter tags, starter staples).

**Done when:** `npm run migrate` twice (second run is a no-op); `psql` shows 10 tables;
`SELECT count(*) FROM tags` ≥ 25.

**Commit:** `M1: schema migrations + taxonomy/pantry seeds`

---

## M2 — Ingestion endpoint skeleton + dedup plumbing

**Goal:** the API surface and URL identity, before any LLM work.

Steps:
1. `normalizeUrl.ts`: lowercase host; strip fragment; remove tracking params
   (`utm_*`, `fbclid`, `gclid`, `igshid`, `si`, `feature`); sort remaining params.
   YouTube special case: any watch/short/share form (`youtu.be/ID`, `/shorts/ID`,
   `watch?v=ID&t=...`) canonicalizes to `https://www.youtube.com/watch?v=<ID>`.
   Export `detectSource(url): 'web' | 'youtube'`.
2. `routes/ingest.ts`: `POST /api/ingest`, header `x-api-key` must equal `INGEST_API_KEY`
   (else 401). Body (zod): `{ url: string, html?: string }`. For now call a stub
   `pipeline.ts` that returns `{ status: "detected", source, normalizedUrl }`.
3. Vitest unit tests for `normalizeUrl` (tracking params, YouTube forms, param ordering).

**Done when:** tests pass; curl without key → 401; curl with a `youtu.be` short link
returns the canonical watch URL and `source: "youtube"`.

**Commit:** `M2: ingest endpoint, URL normalization + source detection`

---

## M3 — Web-page extraction pipeline (the heart)

**Goal:** a real web recipe URL in → enriched, embedded, deduped row out.

Steps:
1. `fetchPage.ts`: fetch with a desktop-browser User-Agent, 15 s timeout. On non-2xx,
   network error, or content that is clearly a bot-wall → throw `NeedsHtmlError`.
   If the request body already included `html`, skip fetching entirely.
2. `jsonld.ts`: parse all `<script type="application/ld+json">` blocks; find the node with
   `@type` of/including `Recipe` (search `@graph` arrays too). Return the raw Recipe node
   or null. Unit-test against 2 saved fixture HTML files (`server/test/fixtures/`).
3. `readable.ts`: jsdom + Readability → `{ title, textContent }` for the no-JSON-LD path.
4. `enrich.ts`: **one** `client.messages.parse` call (Appendix D pattern, Appendix A schema).
   Input content: the JSON-LD Recipe node (preferred) or readability text, plus the page URL.
   The prompt (keep in a template literal, ~30 lines) instructs Claude to:
   - extract title/servings/time/steps/ingredients (`raw_text` preserved verbatim);
   - classify into the provided **approved tag vocabulary** (passed in dynamically),
     proposing `new_tags` only when nothing fits;
   - flag `defining_ingredients` (distinctive, not quantity-based — a spoon of miso counts,
     salt does not);
   - estimate ballpark per-serving macros in-context (sum ingredient estimates ÷ servings);
   - set `partial: true` if the source was too thin for a confident extraction.
5. `embed.ts`: `embedText(text) → number[]` (OpenAI, `text-embedding-3-small`). Build the
   embed string exactly: `"{title}. Ingredients: {defining ingredients, comma-sep}. {Category: value pairs for each tag}"`.
6. `pipeline.ts` (transaction):
   - upsert `recipes` on `source_url` conflict (update all fields, bump `updated_at`);
   - delete + reinsert `ingredients` for the recipe;
   - for `new_tags`: insert with `status='approved'` (auto-approve, per design);
   - replace `recipe_tags`; write `embedding` (`'[...]'::vector` literal).
   - Return `{ status: 'saved' | 'updated', recipeId, title }`.

**Done when:** ingesting 3 real recipe URLs (pick well-known recipe blogs) produces correct
rows (spot-check ingredients + tags via psql); re-ingesting URL #1 returns `updated` and
`SELECT count(*) FROM recipes` is unchanged.

**Commit:** `M3: web extraction pipeline — JSON-LD/readability → enrich → embed → upsert`

---

## M4 — YouTube path

**Goal:** both YouTube branches of the decision tree.

Steps in `youtube.ts`:
1. `getVideoMeta(videoId)`: Data API v3 `videos.list part=snippet` → title, description, channel.
2. `findRecipeLink(description)`: first http(s) URL that is not youtube/instagram/tiktok/
   facebook/twitter/linktr.ee/patreon/amzn — return null if none.
3. `getTranscript(videoId)`: `youtube-transcript`, try/catch → joined text or null. Never throw.
4. Pipeline branch: link found → run the **M3 web path** on that URL (`source_detail` = the
   linked URL; `source_url` stays the canonical YouTube URL); if the linked page fetch fails,
   fall back to branch 5 instead of erroring.
5. No link (or fallback): enrichment input = title + description + transcript-if-available.
   If transcript is null, proceed anyway; the model sets `partial` as appropriate.

**Done when:** ingesting one cooking video with a recipe link in its description and one
Short without a link both produce rows; the Short-without-transcript case saves with
`extraction_partial` correctly reflecting thin input.

**Commit:** `M4: youtube ingestion — link-in-description path + transcript fallback`

---

## M5 — Chrome extension (capture)

**Goal:** one-click save from any tab.

Steps:
1. `manifest.json` (MV3): `action` with popup; permissions `activeTab`, `scripting`, `storage`.
2. `options.html/ts`: fields for API base URL + ingest key → `chrome.storage.sync`.
3. `popup.html/ts`: on open, read active tab URL. Button **Save recipe**:
   - YouTube tab → POST `{ url }` only.
   - Any other tab → `chrome.scripting.executeScript` to read
     `document.documentElement.outerHTML` and POST `{ url, html }` (this also preempts the
     `NEEDS_HTML` bot-block case — the browser already has the page).
   - States: idle → saving… → `Saved ✓` / `Updated ✓ (already in library)` / error message.
4. `build.mjs` (esbuild) bundling to `extension/dist/`; README note on loading unpacked.

**Done when:** loaded unpacked in Chrome; saving a live recipe page and a YouTube video both
land rows via the local server; re-saving shows the "already in library" state.

**Commit:** `M5: chrome extension — one-click capture to ingestion API`

---

## M6 — Agent service & tools

**Goal:** the shared toolset from ARCHITECTURE.md §03 behind `POST /api/chat`.

Steps:
1. `aliases.ts`: `ALLERGEN_ALIASES` from Appendix C.
2. `search.ts`: hybrid search exactly per Appendix B.
3. `tools.ts` — six `betaZodTool`s (signatures per ARCHITECTURE.md §03; no `match_reason`):
   `search_recipes`, `get_recipe`, `create_meal_plan`, `add_recipe_to_plan`,
   `generate_grocery_list` (returns raw lines with quantities pre-scaled:
   `qty × planned_servings / recipe_servings`), `save_grocery_list`.
4. `systemPrompt.ts` builds, at request time: persona ("recipe library assistant"); the
   **approved tag vocabulary** grouped by category; the **pantry staples list**; rules:
   - exclusions/dietary are best-effort — remind the user to verify via source link when
     allergy language appears;
   - macros are ballpark estimates — say "≈" when quoting them;
   - grocery flow: `generate_grocery_list` → consolidate duplicate lines fuzzily
     ("2 cloves garlic" + "1 head garlic" → one line, ballpark total) **and** drop pantry
     staples (fuzzy match: "sea salt" ≈ "salt") in the same pass → `save_grocery_list`.
5. `routes/chat.ts`: `POST /api/chat` body `{ messages: {role, content}[] }` (client holds
   history; no persistence). Run the toolRunner (Appendix D). Response:
   `{ reply: string, toolEvents: { tool: string, input: unknown, output: unknown }[] }` —
   the UI renders cards from `toolEvents`.

**Done when (scripted curl conversations):**
1. "I have eggplant and miso, no meat please" → `search_recipes` fires with sensible args,
   relevant recipes return; 2. "Plan dinners Mon–Wed from those and make me a grocery list"
   → plan rows + grocery rows exist in psql, staples absent from the saved list, duplicate
   ingredients consolidated.

**Commit:** `M6: agent service — six tools, hybrid search, chat endpoint`

---

## M7 — Web UI

**Goal:** minimal but pleasant chat client + management screens.

Steps:
1. Vite React app (`web/`), dev proxy to the server.
2. Chat screen: message list, input, client-held history posted to `/api/chat`; non-streaming.
   Render `toolEvents`: recipe cards (title, tags, ≈ macros badge, source link), meal-plan
   table, grocery checklist (checkbox → `PATCH /api/grocery-items/:id`).
3. Library screen: `GET /api/recipes` grid; recipe detail from `GET /api/recipes/:id`
   (always shows source link + "≈ estimated" macros badge).
4. Settings screen: pantry staples add/remove; tags list with rename, delete, and **merge**
   (server: `POST /api/tags/:id/merge { into_tag_id }` → repoint `recipe_tags`, delete source
   tag, inside a transaction).

**Done when:** full flow in the browser — chat finds recipes, builds a plan, shows the
grocery list with checkboxes; a tag rename is immediately reflected on recipe cards.

**Commit:** `M7: web ui — chat, library, settings (pantry + tag management)`

---

## M8 — Hardening & docs

**Goal:** finish line for the MVP.

Steps:
1. Consistent error shape `{ error: string }` on all routes; request logging middleware.
2. `npm run smoke`: script that ingests a fixture HTML file end-to-end against a running
   server and asserts a row exists.
3. README: setup (Docker, keys incl. where to get the YouTube key, migrate, three dev
   commands, load the extension), plus a short architecture pointer.
4. Final pass on `ARCHITECTURE.md`: if implementation diverged anywhere, update the doc
   (do not leave the docs lying).

**Done when:** MVP checklist below is fully green.

**Commit:** `M8: hardening, smoke test, setup docs`

### MVP definition of done
- [ ] Save a recipe-blog page from the extension → correct structured row
- [ ] Save a YouTube video with recipe link → row extracted from the linked page
- [ ] Save a Short with no link → partial-tolerant row from description/transcript
- [ ] Re-save any of the above → update, not duplicate
- [ ] Chat: ingredient-based query returns relevant recipes, exclusions respected
- [ ] Chat: build a 3-dinner plan → grocery list scaled, consolidated, staples removed
- [ ] Tags: rename + merge work from settings; new-cuisine recipe auto-adds a tag
- [ ] All secrets in `.env`; `.env.example` complete; README setup works from scratch

---

## Appendix A — Enrichment output schema (zod)

```ts
const Enrichment = z.object({
  title: z.string(),
  servings: z.number().int().nullable(),
  total_time_min: z.number().int().nullable(),
  steps: z.array(z.string()),
  ingredients: z.array(z.object({
    name: z.string(),                    // normalized, lowercase: "garlic"
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
    raw_text: z.string(),                // verbatim source line
  })),
  defining_ingredients: z.array(z.string()), // subset of ingredient names
  tags: z.object({                       // values MUST come from the provided vocabulary
    cuisine: z.array(z.string()),
    dish_type: z.array(z.string()),
    dietary: z.array(z.string()),
  }),
  new_tags: z.array(z.object({           // only when nothing in the vocabulary fits
    category: z.enum(["cuisine", "dish_type", "dietary"]),
    value: z.string(),
  })),
  macros_per_serving: z.object({
    kcal: z.number(), protein_g: z.number(), carbs_g: z.number(), fat_g: z.number(),
  }).nullable(),
  partial: z.boolean(),                   // true when source was too thin
});
```

## Appendix B — Hybrid search (search_recipes)

Build one parameterized query; every filter is optional:

```sql
SELECT r.id, r.title, r.kcal, r.protein_g, r.carbs_g, r.fat_g, r.total_time_min
FROM recipes r
WHERE
  -- must_exclude: name OR raw_text, expanded through ALLERGEN_ALIASES (best-effort)
  NOT EXISTS (SELECT 1 FROM ingredients i WHERE i.recipe_id = r.id
              AND (i.name ILIKE ANY($excl_patterns) OR i.raw_text ILIKE ANY($excl_patterns)))
  -- must_have: every required ingredient present
  AND NOT EXISTS (SELECT 1 FROM unnest($must_have::text[]) AS need(term)
                  WHERE NOT EXISTS (SELECT 1 FROM ingredients i
                                    WHERE i.recipe_id = r.id AND i.name ILIKE '%'||need.term||'%'))
  -- each tag filter (cuisine / dish_type / dietary), when non-empty:
  AND EXISTS (SELECT 1 FROM recipe_tags rt JOIN tags t ON t.id = rt.tag_id
              WHERE rt.recipe_id = r.id AND t.category = 'dietary' AND t.value = ANY($dietary))
  AND ($max_time::int IS NULL OR r.total_time_min <= $max_time)
ORDER BY
  CASE WHEN $query_embedding::vector IS NULL THEN NULL
       ELSE r.embedding <=> $query_embedding::vector END
  NULLS LAST, r.created_at DESC
LIMIT $limit;
```

`$excl_patterns` = for each `must_exclude` term, `%term%` plus `%alias%` for every alias in
`ALLERGEN_ALIASES[term]`. Empty `query` → skip the embedding call, order by recency.

## Appendix C — Seed data

**Tag categories:** `cuisine`, `dish_type`, `dietary`.

**Starter tags (all `approved`):**
- cuisine: Mediterranean, Japanese, Taiwanese, Chinese, Korean, Thai, Vietnamese, Indian,
  Italian, French, Mexican, American
- dish_type: breakfast, salad, soup, main, side, dessert, snack, drink
- dietary: vegetarian, vegan, gluten-free, dairy-free, nut-free, pescatarian

**Starter pantry staples:** salt, black pepper, olive oil, neutral oil, sugar, flour,
butter, soy sauce, garlic, water. (User-editable in Settings.)

**`ALLERGEN_ALIASES` (TS const in `aliases.ts`):**
```ts
{
  peanut:    ["peanuts", "groundnut", "satay", "peanut butter"],
  tree_nut:  ["almond", "cashew", "walnut", "pecan", "pistachio", "hazelnut", "macadamia"],
  gluten:    ["wheat", "flour", "soy sauce", "barley", "rye", "panko", "breadcrumb"],
  dairy:     ["milk", "butter", "cream", "cheese", "yogurt", "ghee"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "oyster", "clam", "mussel", "scallop"],
  egg:       ["eggs", "mayonnaise", "mayo", "aioli"],
  soy:       ["soybean", "tofu", "edamame", "soy sauce", "miso", "tempeh"],
  sesame:    ["tahini", "sesame oil", "sesame seeds"],
}
```
A plain term not in this map is used as-is (`%term%`).

## Appendix D — Anthropic SDK patterns (copy these; do not improvise)

**Enrichment (structured outputs):**
```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const response = await client.messages.parse({
  model: "claude-sonnet-5",
  max_tokens: 8192,
  system: ENRICHMENT_PROMPT,            // includes the approved tag vocabulary
  messages: [{ role: "user", content: sourceText }],
  output_config: { format: zodOutputFormat(Enrichment) },
});
const data = response.parsed_output;    // typed; null if parsing failed → treat as error
```

**Agent loop (tool runner):**
```ts
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

const searchRecipes = betaZodTool({
  name: "search_recipes",
  description: "Search the recipe library. Call this whenever the user asks what to cook, " +
    "mentions ingredients they have, or asks for meal ideas.",
  inputSchema: SearchInput,             // zod object per ARCHITECTURE.md §03
  run: async (input) => JSON.stringify(await hybridSearch(input)),
});

const finalMessage = await client.beta.messages.toolRunner({
  model: "claude-sonnet-5",
  max_tokens: 4096,
  system: buildSystemPrompt(vocab, staples),
  tools: [searchRecipes, getRecipe, createMealPlan, addRecipeToPlan,
          generateGroceryList, saveGroceryList],
  messages: clientMessages,
});
```

**Embeddings (OpenAI):**
```ts
import OpenAI from "openai";
const openai = new OpenAI();
const { data } = await openai.embeddings.create({
  model: "text-embedding-3-small",      // 1536 dims — matches vector(1536)
  input: embedString,
});
const vector = data[0].embedding;
// insert as literal: `[${vector.join(",")}]` cast with ::vector
```
