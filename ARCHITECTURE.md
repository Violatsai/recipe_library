# Recipe Library — Architecture Reference

A personal system that turns bookmarked recipes — from web pages and YouTube — into a structured, searchable library you can cook from and plan meals against, by chatting with an agent.

- **Scope:** single-user side project
- **Store:** Postgres + pgvector
- **Models:** Claude · a dedicated embedding model

> A styled version of this document lives at [`docs/architecture.html`](docs/architecture.html).

## Data flow

```
Capture  ──▶  Library  ──▶  Agent + Tools  ──▶  Chat UI
```

| Layer | Role |
|---|---|
| **01 · Capture** | Extension grabs a page or video; ingestion extracts, scores macros, tags, embeds. |
| **02 · Library** | Structured recipes, ingredients, taxonomy, meal plans — the shared core. |
| **03 · Agent + Tools** | One toolset over the library: search, plan, build a grocery list. |
| **04 · Chat UI** | One thread for "what can I cook?" and "plan my week." |

---

## 01 · Capture & ingestion

The extension sends raw source content to an ingestion worker. Three source types collapse into **two extraction strategies** — fetch a clean page, or extract from a transcript — so most of the pipeline is shared.

### Source decision tree

```
# Web page
schema.org/Recipe JSON-LD present?  ──yes──▶  parse → clean structured input to the LLM pass
                                    ──no───▶  raw page text to the LLM pass
                                              (vision fallback for JS-heavy / image recipes)

# YouTube
recipe link in description?
   yes → fetch it · has Recipe JSON-LD → extract from the page (high confidence)
                  · no markup          → hand Claude BOTH the page text + the video
                                         (title/desc/transcript); it uses the page if it's
                                         the right dish, else the video — a sponsor/shop page
                                         is ignored (source_used records the choice)
                  · unfetchable        → fall through ↓
   no  → transcript + description to the LLM pass
         (primary path for Shorts; transcript is best-effort)

# Either way: EVERY recipe gets exactly one LLM enrichment pass
# (extraction where needed, tags, macros, defining ingredients) + one embedding call.
# JSON-LD doesn't skip the pass — it makes the input cleaner and cheaper.
```

Whichever strategy runs, one structured-output pass produces the whole record — Claude returns validated JSON matching the recipe schema, so there is no free-form parsing to babysit.

**Dedup at the front door.** `recipes.source_url` is normalized (tracking params stripped) and carries a unique index; ingestion upserts on conflict, so re-saving a bookmark updates the existing row instead of creating a twin — and the extension can report "already saved." Same-dish-from-a-different-URL isn't caught by this; see Deferred.

### What the ingestion pass produces

```
// all emitted together, per recipe:
title, servings, total_time, steps[]
ingredients[]          // name · quantity · unit · raw_text
defining_ingredients[] // Claude flags which ones characterize the dish → embedding
tags                   // classified into the approved controlled vocabulary
macros                 // ballpark, per serving — see below
```

**Macros — ballpark by design.** Estimated by the LLM, not looked up: per-ingredient values from knowledge, summed and divided by servings in-context within the same pass. No `code_execution` step — the per-ingredient estimates carry ±20–30% error, so exact arithmetic on top of them buys nothing but an extra round-trip. Computed **once at ingestion** and stored. The `estimated` flag is data, not prose — the UI renders a consistent "≈ estimated" badge.

**Embedding string.** Built from **title + defining ingredients + tags** — not the full ingredient list, and never the cooking steps. Claude flags the *defining* ingredients in the same pass, so a spoon of miso survives while salt and water drop out. One vector per recipe, from a dedicated embedding model, written at ingestion. Changing this string later means re-embedding the library.

---

## 02 · Recipe library — schema

Postgres for the structured queries meal planning needs; pgvector for semantic search. Everything the agent touches lives here. No users table — single-user.

### Core

```
recipes                          -- one row per recipe
  id              uuid pk
  title           text
  source_url      text unique    -- normalized (tracking params stripped); upsert on conflict
  source_type     text           -- 'web' | 'youtube'
  source_detail   text           -- resolved recipe URL from a YT description
  servings        int
  total_time_min  int
  steps           jsonb          -- ordered array of step strings
  description     text           -- raw captured text, for re-extraction
  kcal            numeric        -- ballpark macros, per serving ↓
  protein_g       numeric
  carbs_g         numeric
  fat_g           numeric
  macros_estimated bool default true    -- drives the "≈ estimated" badge
  macros_method   text default 'llm_estimate'
  embedding       vector(1024)   -- title + defining ingredients + tags (Voyage voyage-4-lite)
  created_at      timestamptz default now()

ingredients                      -- recipe_id → recipes
  id          uuid pk
  recipe_id   uuid fk
  name        text               -- normalized: "garlic"
  quantity    numeric            -- nullable ("a pinch")
  unit        text               -- 'g','ml','clove','tbsp' · nullable
  raw_text    text               -- original line, fallback when parse fails
```

### Taxonomy — controlled vocabulary

```
tag_categories   id('cuisine'|'dish_type'|'dietary'), label

tags             id, category fk, value, status
                 -- status: 'approved' | 'pending' — kept for an optional review mode later
                 -- unique(category, value)

recipe_tags      recipe_id fk, tag_id fk   -- pk(recipe_id, tag_id)
```

Claude classifies into existing tags first and proposes a new value only when nothing fits — and new tags are **auto-approved immediately**. At single-user scale a review queue means *you* are the review queue; cleanup happens instead through rename / merge / delete, which propagate through `recipe_tags` automatically because tags are rows. The `status` column stays in the schema so a review mode can be switched on later if vocabulary drift actually materializes.

### Meal planning

```
meal_plans          id, title, start_date, created_at

meal_plan_recipes   id, meal_plan_id fk, recipe_id fk,
                    day, meal_slot,   -- both nullable
                    servings          -- planned; may differ from recipe default

grocery_lists       id, meal_plan_id fk, created_at

grocery_items       id, grocery_list_id fk, name, quantity, unit,
                    checked,   -- tick off while shopping
                    category   -- store section (produce, meat & seafood, …),
                               -- assigned by the agent at consolidation; UI groups by it

pantry_staples      id, name   -- user-managed; subtracted from generated lists
```

**Two staple lists — don't conflate.** `pantry_staples` = ingredients you keep at home (user-declared, drives grocery subtraction). That is a **different mechanism** from the embedding's defining-ingredients (Claude's per-recipe judgment about what characterizes the dish). They overlap in content — salt is in both — but are managed and used separately.

---

## 03 · Agent + tools

One agent, one shared toolset. "What's in my fridge?" (retrieval) and "plan my week" (planning) are two conversations against the same tools — so the agent can chain *find → plan → grocery list* in a single thread.

### Read — safe, parallel

```
search_recipes(                  // hybrid: vector + SQL
  query: str,            // natural language → embedded → pgvector rank
  must_have:   [str],    // hard filter
  must_exclude:[str],    // SQL pre-filter — never semantic; best-effort coverage
  cuisine:     [str],    // tag filters
  dish_type:   [str],
  dietary:     [str],    // SQL pre-filter — never semantic; best-effort coverage
  max_time_min:int,
  limit:       int
) → { results: [{ id, title, cuisine, dish_type, macros }],
      semantic_ranking: bool,   // false = embedding unavailable; filters still applied,
      note? }                   //        ordering degraded to recency

get_recipe(id) → { full steps, ingredients, macros, tags, source_url }
```

The tool does the embedding call and the DB query — the agent only passes text. The approved tag vocabulary is **injected into the agent's system prompt** so it can map "something Japanese" to a valid filter with no extra round-trip.

**Hard pre-filters, best-effort coverage.** `must_exclude` and `dietary` are **SQL filters applied before semantic ranking** — never left to embedding similarity, since "no peanuts" is an allergy, not a ranking preference. But coverage is honestly best-effort, not a guarantee: exclusion matches against both ingredient `name` and `raw_text`, expanded through a small per-allergen alias list (peanut → groundnut, satay, …), and `dietary` tags are LLM-inferred at ingestion with known failure modes (soy sauce contains gluten). Treat these as convenience filters; the source link is always shown so the user can verify. Only the free-text `query` takes the fuzzy vector path.

### Write — meal planning

```
create_meal_plan(title, start_date) → meal_plan_id
add_recipe_to_plan(meal_plan_id, recipe_id, day?, meal_slot?, servings?)

generate_grocery_list(meal_plan_id)
  → [{ name, quantity, unit, from_recipe }]   // raw lines, quantities PRE-SCALED
save_grocery_list(meal_plan_id, items[]) → grocery_list_id
```

**Grocery aggregation — split by what each side is good at.** *Deterministic scaling* (planned ÷ recipe servings) happens in the tool. Then *one agent pass* does everything fuzzy: merging duplicate lines ("these three are all chicken, ≈ X total") *and* dropping pantry staples in the same step — using the same fuzzy matching to catch "sea salt" ≈ "salt". The cleaned result is persisted via `save_grocery_list`.

**Gating boundary — nothing to build yet.** All current tools are internal, single-user, reversible — no confirmation needed. The seam to watch: the first **outward** action (order from Instacart, email the list) is hard to reverse and *should* be gated behind explicit confirmation.

---

## 04 · Chat UI

A single web app; chat is the entry point for both retrieval and planning. It renders the agent's tool results: clickable recipe cards (→ detail overlay), a week's plan with hyperlinked recipes, and a grocery checklist with two views — by store section (persisted checkboxes) or by recipe (derived, read-only). Beyond chat: a **Library** tab (search by title/ingredient, tag filters, delete), a **Plans** tab (persistent home for meal plans + grocery lists, with editable title/date), and **Settings** (pantry + tag management).

---

## Settled decisions

| Area | Decision |
|---|---|
| **ingestion** | JSON-LD as clean input where present; every recipe gets exactly one LLM enrichment pass. YouTube link-in-description → `web_fetch`. Re-saves dedupe via unique normalized `source_url` + upsert. |
| **macros** | LLM ballpark, in-context arithmetic (no `code_execution`), at ingestion, per serving, `estimated` flag. No nutrition DB. |
| **tags** | Controlled vocabulary only, 3 axes, new tags auto-approved; merge/rename is the cleanup mechanism. Injected in prompt (not a `list_tags` tool — yet). |
| **embedding** | title + defining ingredients + tags; Claude flags defining ones; dedicated embedding model; at ingestion, from day one. |
| **search** | Hybrid. Exclusions & dietary are SQL pre-filters (best-effort: name + raw_text + allergen aliases); only free-text query is semantic. |
| **grocery** | Deterministic scaling in tool; fuzzy merge + staple removal in one agent pass. |
| **models** | Extraction: try Sonnet / Haiku first (test accuracy). Agent: Claude. Embeddings: dedicated model. |
| **stack** | Postgres + pgvector, MV3 extension, minimal / no auth (single-user). |

---

## Implementation risks

- **YouTube transcripts are the flakiest dependency.** The official Data API doesn't expose captions for videos you don't own; unofficial transcript scrapers break periodically. Description-first always; transcript best-effort with graceful partial saves ("saved with partial info — open the video to complete").
- **`web_fetch` will bounce off bot-blocked recipe sites** (Cloudflare et al.). Fallback: the extension *is* a browser — it fetches the URL client-side and ships raw HTML up. Design the ingestion API to accept both "here's a URL" and "here's raw HTML" from day one.
- **If the ingestion API is hosted publicly** (not localhost), it needs at least a static API key even single-user — otherwise anyone with the URL can write to the library.
- **Voyage free tier without a payment method = 3 requests/min** — one enthusiastic chat turn can exceed it. Mitigated in code: `embedText` retries on 429 with backoff, and search degrades to filters + recency ordering (flagged via `semantic_ranking: false`) instead of failing. Adding a card to the Voyage account lifts the cap; the 200M free tokens still apply.

---

## Deferred — known seams

- **Chat persistence.** A `conversations`/`messages` pair if you want thread history — independent of the recipe data.
- **`list_tags` migration.** When the vocabulary grows large, switch from in-prompt injection to a category-scoped tool. Localized change; search interface unaffected.
- **Outward-action gating.** Add confirmation the moment a tool reaches outside (ordering, emailing).
- **Soft staple handling.** Option to show staples in an "assumed on hand" section instead of hard-dropping — same underlying match.
- **Semantic dedup.** URL-dedup won't catch the same dish saved from two different sites; embedding similarity at save time ("this looks like a recipe you already have") is a natural later add.
- **Re-enrichment on edit.** If a recipe's servings or ingredients are ever edited, re-run macros + embedding; nothing recomputes automatically today.
