-- Recipe Library schema. Mirrors ARCHITECTURE.md §02 plus the approved additions
-- (extraction_partial, updated_at, embedding vector(1024)). gen_random_uuid() is
-- built into Postgres core (13+); no extension needed for UUIDs.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Core
-- ---------------------------------------------------------------------------
CREATE TABLE recipes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL,
  source_url         text NOT NULL UNIQUE,          -- normalized; ingestion upserts on conflict
  source_type        text NOT NULL CHECK (source_type IN ('web', 'youtube')),
  source_detail      text,                          -- e.g. resolved recipe URL from a YT description
  servings           int,
  total_time_min     int,
  steps              jsonb NOT NULL DEFAULT '[]'::jsonb,
  description        text,                          -- raw captured text, for re-extraction
  kcal               numeric,                       -- ballpark macros, per serving
  protein_g          numeric,
  carbs_g            numeric,
  fat_g              numeric,
  macros_estimated   bool NOT NULL DEFAULT true,    -- drives the "≈ estimated" badge
  macros_method      text NOT NULL DEFAULT 'llm_estimate',
  embedding          vector(1024),                  -- title + defining ingredients + tags (Voyage voyage-4-lite)
  extraction_partial bool NOT NULL DEFAULT false,   -- true when source was too thin (graceful partial save)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingredients (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id  uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  name       text NOT NULL,                         -- normalized, lowercase: "garlic"
  quantity   numeric,                               -- nullable ("a pinch")
  unit       text,                                  -- 'g','ml','clove','tbsp' · nullable
  raw_text   text NOT NULL                          -- original line, fallback when parse fails
);
CREATE INDEX ingredients_recipe_id_idx ON ingredients (recipe_id);

-- ---------------------------------------------------------------------------
-- Taxonomy (controlled vocabulary)
-- ---------------------------------------------------------------------------
CREATE TABLE tag_categories (
  id     text PRIMARY KEY,                          -- 'cuisine' | 'dish_type' | 'dietary'
  label  text NOT NULL
);

CREATE TABLE tags (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category  text NOT NULL REFERENCES tag_categories(id),
  value     text NOT NULL,
  status    text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'pending')),
  UNIQUE (category, value)
);

CREATE TABLE recipe_tags (
  recipe_id  uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (recipe_id, tag_id)
);
CREATE INDEX recipe_tags_tag_id_idx ON recipe_tags (tag_id);  -- for tag merge/rename repointing

-- ---------------------------------------------------------------------------
-- Meal planning
-- ---------------------------------------------------------------------------
CREATE TABLE meal_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  start_date  date,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meal_plan_recipes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_plan_id  uuid NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  recipe_id     uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  day           date,                               -- nullable
  meal_slot     text,                               -- 'breakfast'|'lunch'|'dinner' · nullable
  servings      int                                 -- planned; may differ from recipe default
);
CREATE INDEX meal_plan_recipes_plan_id_idx ON meal_plan_recipes (meal_plan_id);

CREATE TABLE grocery_lists (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_plan_id  uuid NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE grocery_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grocery_list_id  uuid NOT NULL REFERENCES grocery_lists(id) ON DELETE CASCADE,
  name             text NOT NULL,
  quantity         numeric,
  unit             text,
  checked          bool NOT NULL DEFAULT false      -- tick off while shopping
);
CREATE INDEX grocery_items_list_id_idx ON grocery_items (grocery_list_id);

CREATE TABLE pantry_staples (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name  text NOT NULL UNIQUE                        -- user-managed; subtracted from generated lists
);

-- ---------------------------------------------------------------------------
-- Vector index for semantic search (cosine distance, matches Voyage embeddings)
-- ---------------------------------------------------------------------------
CREATE INDEX recipes_embedding_idx ON recipes USING hnsw (embedding vector_cosine_ops);
