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
schema.org/Recipe JSON-LD present?  ──yes──▶  parse directly (free, no LLM)
                                    ──no───▶  LLM extraction over page text
                                              (vision fallback for JS-heavy / image recipes)

# YouTube
recipe URL in description?  ──yes──▶  web_fetch the linked page  ──▶  (same as web page)
                            ──no───▶  LLM extraction over transcript + description
                                      (primary path for Shorts)
```

Whichever strategy runs, one structured-output pass produces the whole record — Claude returns validated JSON matching the recipe schema, so there is no free-form parsing to babysit.

### What the ingestion pass produces

```
// all emitted together, per recipe:
title, servings, total_time, steps[]
ingredients[]          // name · quantity · unit · raw_text
defining_ingredients[] // Claude flags which ones characterize the dish → embedding
tags                   // classified into the approved controlled vocabulary
macros                 // ballpark, per serving — see below
```

**Macros — ballpark by design.** Estimated by the LLM, not looked up. Claude estimates per-ingredient values from knowledge, then does the summing arithmetic inside the `code_execution` tool (deterministic math where LLMs are weak), divided by servings. Computed **once at ingestion** and stored. The `estimated` flag is data, not prose — the UI renders a consistent "≈ estimated" badge.

**Embedding string.** Built from **title + defining ingredients + tags** — not the full ingredient list, and never the cooking steps. Claude flags the *defining* ingredients in the same pass, so a spoon of miso survives while salt and water drop out. One vector per recipe, from a dedicated embedding model, written at ingestion. Changing this string later means re-embedding the library.

---

## 02 · Recipe library — schema

Postgres for the structured queries meal planning needs; pgvector for semantic search. Everything the agent touches lives here. No users table — single-user.

### Core

```
recipes                          -- one row per recipe
  id              uuid pk
  title           text
  source_url      text
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
  embedding       vector(1536)   -- title + defining ingredients + tags
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
                 -- status: 'approved' | 'pending'  ← the whole growth mechanism
                 -- unique(category, value)

recipe_tags      recipe_id fk, tag_id fk   -- pk(recipe_id, tag_id)
```

Claude classifies into **approved** tags; anything genuinely new is emitted as **pending** for review (or auto-approve after N sightings). User can rename / merge / delete tags — because they're rows, changes propagate through `recipe_tags` automatically.

### Meal planning

```
meal_plans          id, title, start_date, created_at

meal_plan_recipes   id, meal_plan_id fk, recipe_id fk,
                    day, meal_slot,   -- both nullable
                    servings          -- planned; may differ from recipe default

grocery_lists       id, meal_plan_id fk, created_at

grocery_items       id, grocery_list_id fk, name, quantity, unit,
                    checked  -- tick off while shopping

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
  must_exclude:[str],    // HARD filter — never semantic
  cuisine:     [str],    // tag filters
  dish_type:   [str],
  dietary:     [str],    // HARD filter — never semantic
  max_time_min:int,
  limit:       int
) → [{ id, title, cuisine, dish_type, macros, match_reason }]

get_recipe(id) → { full steps, ingredients, macros, tags, source_url }
```

The tool does the embedding call and the DB query — the agent only passes text. The approved tag vocabulary is **injected into the agent's system prompt** so it can map "something Japanese" to a valid filter with no extra round-trip.

**The one strict rule.** `must_exclude` and `dietary` are **hard SQL filters applied before semantic ranking** — never left to embedding similarity. "No peanuts" is an allergy, not a ranking preference; a close-but-wrong match is a real problem. Only the free-text `query` takes the fuzzy vector path.

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

A single web app and a single chat surface is the entry point for both retrieval and planning — potentially the same persistent thread rather than two screens. It renders the agent's tool results: recipe cards, a week's plan, an editable grocery list with staples already removed.

---

## Settled decisions

| Area | Decision |
|---|---|
| **ingestion** | JSON-LD first, LLM fallback. YouTube link-in-description → `web_fetch`. Three sources → two strategies. |
| **macros** | LLM ballpark via `code_execution`, at ingestion, per serving, `estimated` flag. No nutrition DB. |
| **tags** | Controlled vocabulary only, 3 axes, pending→approved growth. Injected in prompt (not a `list_tags` tool — yet). |
| **embedding** | title + defining ingredients + tags; Claude flags defining ones; dedicated embedding model; at ingestion. |
| **search** | Hybrid. Exclusions & dietary are hard filters; only free-text query is semantic. |
| **grocery** | Deterministic scaling in tool; fuzzy merge + staple removal in one agent pass. |
| **models** | Extraction: try Sonnet / Haiku first (test accuracy). Agent: Claude. Embeddings: dedicated model. |
| **stack** | Postgres + pgvector, MV3 extension, minimal / no auth (single-user). |

---

## Deferred — known seams

- **Chat persistence.** A `conversations`/`messages` pair if you want thread history — independent of the recipe data.
- **`list_tags` migration.** When the vocabulary grows large, switch from in-prompt injection to a category-scoped tool. Localized change; search interface unaffected.
- **Outward-action gating.** Add confirmation the moment a tool reaches outside (ordering, emailing).
- **Soft staple handling.** Option to show staples in an "assumed on hand" section instead of hard-dropping — same underlying match.
