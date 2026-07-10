import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod/v4";
import { query, withTransaction } from "../db.js";
import { fetchRecipeDetail } from "../recipeQueries.js";
import { hybridSearch, type SearchInput } from "./search.js";

export interface ToolEvent {
  tool: string;
  input: unknown;
  output: unknown;
}

/** Store sections for grocery lists — assigned by the agent at consolidation. */
export const GROCERY_CATEGORIES = [
  "produce",
  "meat & seafood",
  "dairy & eggs",
  "condiments & sauces",
  "spices & seasoning",
  "grains & pantry",
  "other",
] as const;

/** Deterministic serving scale for grocery lines (pure — unit-tested). */
export function scaleQuantity(
  quantity: number | null,
  planned: number | null,
  recipeServings: number | null,
): number | null {
  if (quantity == null) return null;
  if (planned == null || recipeServings == null || recipeServings <= 0) return quantity;
  return Math.round((quantity * planned) / recipeServings * 100) / 100;
}

/** Build the toolset for one request, recording each call into `events`. */
export function buildTools(events: ToolEvent[]): BetaRunnableTool<unknown>[] {
  const record = <I>(
    name: string,
    description: string,
    inputSchema: z.ZodType<I>,
    run: (input: I) => Promise<unknown>,
  ): BetaRunnableTool<I> =>
    betaZodTool({
      name,
      description,
      inputSchema,
      run: async (input: I) => {
        const output = await run(input);
        events.push({ tool: name, input, output });
        return JSON.stringify(output);
      },
    });

  const searchInput = z.object({
    query: z.string().optional().describe("natural-language description of what to cook / craving"),
    must_have: z.array(z.string()).optional().describe("ingredients the recipe MUST contain"),
    must_exclude: z.array(z.string()).optional().describe("ingredients to hard-exclude (allergies, dislikes)"),
    cuisine: z.array(z.string()).optional().describe("cuisine tags from the approved vocabulary"),
    dish_type: z.array(z.string()).optional().describe("dish_type tags from the approved vocabulary"),
    dietary: z.array(z.string()).optional().describe("dietary tags from the approved vocabulary"),
    max_time_min: z.number().int().nullable().optional().describe("max total time in minutes"),
    limit: z.number().int().optional().describe("max results (default 10)"),
  });

  const searchRecipes = record(
    "search_recipes",
    "Search the user's recipe library. Call this whenever the user asks what to cook, " +
      "mentions ingredients they have, or asks for meal ideas. Free-text `query` drives " +
      "semantic ranking; the other fields are hard filters. Returns { results, " +
      "semantic_ranking, note? } — when semantic_ranking is false the filters still " +
      "applied but ordering fell back to recency; briefly mention that to the user.",
    searchInput,
    async (input) => {
      const normalized: SearchInput = {
        query: input.query ?? "",
        must_have: input.must_have ?? [],
        must_exclude: input.must_exclude ?? [],
        cuisine: input.cuisine ?? [],
        dish_type: input.dish_type ?? [],
        dietary: input.dietary ?? [],
        max_time_min: input.max_time_min ?? null,
        limit: input.limit ?? 10,
      };
      return hybridSearch(normalized);
    },
  );

  const getRecipe = record(
    "get_recipe",
    "Fetch full details for one recipe by id: ingredients, steps, macros, tags, source URL. " +
      "Call this when the user wants to actually cook a recipe or see its details.",
    z.object({ id: z.string() }),
    async ({ id }) => (await fetchRecipeDetail(id)) ?? { error: "recipe not found" },
  );

  const createMealPlan = record(
    "create_meal_plan",
    "Create a new meal plan. Call once before adding recipes to it.",
    z.object({
      title: z.string(),
      start_date: z.string().nullable().optional().describe("ISO date (YYYY-MM-DD) or null"),
    }),
    async ({ title, start_date }) => {
      const row = (
        await query<{ id: string }>(
          "INSERT INTO meal_plans (title, start_date) VALUES ($1, $2) RETURNING id",
          [title, start_date ?? null],
        )
      ).rows[0]!;
      return { meal_plan_id: row.id };
    },
  );

  const addRecipeToPlan = record(
    "add_recipe_to_plan",
    "Add one recipe to a meal plan. Call once per recipe. `servings` is how many servings " +
      "to plan for (may differ from the recipe's default — it scales the grocery list).",
    z.object({
      meal_plan_id: z.string(),
      recipe_id: z.string(),
      day: z.string().nullable().optional().describe("ISO date or null"),
      meal_slot: z.string().nullable().optional().describe("breakfast | lunch | dinner or null"),
      servings: z.number().int().nullable().optional(),
    }),
    async ({ meal_plan_id, recipe_id, day, meal_slot, servings }) => {
      const row = (
        await query<{ id: string }>(
          `INSERT INTO meal_plan_recipes (meal_plan_id, recipe_id, day, meal_slot, servings)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [meal_plan_id, recipe_id, day ?? null, meal_slot ?? null, servings ?? null],
        )
      ).rows[0]!;
      return { ok: true, meal_plan_recipe_id: row.id };
    },
  );

  const generateGroceryList = record(
    "generate_grocery_list",
    "Return the RAW ingredient lines for every recipe in a meal plan, with quantities " +
      "already scaled to each recipe's planned servings. These are unconsolidated — YOU then " +
      "merge duplicate items (fuzzily) and drop pantry staples, then call save_grocery_list.",
    z.object({ meal_plan_id: z.string() }),
    async ({ meal_plan_id }) => {
      const rows = (
        await query<{
          name: string;
          unit: string | null;
          quantity: number | null;
          planned: number | null;
          recipe_servings: number | null;
          title: string;
        }>(
          `SELECT i.name, i.unit, i.quantity, mpr.servings AS planned,
                  r.servings AS recipe_servings, r.title
             FROM meal_plan_recipes mpr
             JOIN recipes r ON r.id = mpr.recipe_id
             JOIN ingredients i ON i.recipe_id = r.id
             WHERE mpr.meal_plan_id = $1
             ORDER BY r.title, i.name`,
          [meal_plan_id],
        )
      ).rows;
      return rows.map((row) => ({
        name: row.name,
        quantity: scaleQuantity(row.quantity, row.planned, row.recipe_servings),
        unit: row.unit,
        from_recipe: row.title,
      }));
    },
  );

  const saveGroceryList = record(
    "save_grocery_list",
    "Persist the FINAL consolidated grocery list for a meal plan (after merging duplicates " +
      "and removing pantry staples). Pass one entry per distinct item, each with its store " +
      "section `category` so the list renders grouped for shopping.",
    z.object({
      meal_plan_id: z.string(),
      items: z.array(
        z.object({
          name: z.string(),
          quantity: z.number().nullable().optional(),
          unit: z.string().nullable().optional(),
          category: z.enum(GROCERY_CATEGORIES),
        }),
      ),
    }),
    async ({ meal_plan_id, items }) => {
      return withTransaction(async (client) => {
        const list = (
          await client.query<{ id: string }>(
            "INSERT INTO grocery_lists (meal_plan_id) VALUES ($1) RETURNING id",
            [meal_plan_id],
          )
        ).rows[0]!;
        for (const it of items) {
          await client.query(
            "INSERT INTO grocery_items (grocery_list_id, name, quantity, unit, category) VALUES ($1, $2, $3, $4, $5)",
            [list.id, it.name, it.quantity ?? null, it.unit ?? null, it.category],
          );
        }
        return { grocery_list_id: list.id, count: items.length };
      });
    },
  );

  const addPantryStaples = record(
    "add_pantry_staples",
    "Add items to the user's PERMANENT pantry staples (things they always keep on hand — " +
      "these are excluded from every future grocery list). Only call when the user says they " +
      "always have an item or explicitly asks to add it to their staples/pantry. Do NOT call " +
      "for one-off 'I already have X this week' remarks.",
    z.object({ names: z.array(z.string().min(1)).min(1) }),
    async ({ names }) => {
      const added: string[] = [];
      const already: string[] = [];
      for (const raw of names) {
        const name = raw.trim().toLowerCase();
        if (!name) continue;
        const r = await query<{ name: string }>(
          "INSERT INTO pantry_staples (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING name",
          [name],
        );
        (r.rowCount === 0 ? already : added).push(name);
      }
      const staples = (
        await query<{ name: string }>("SELECT name FROM pantry_staples ORDER BY name")
      ).rows.map((r) => r.name);
      return { added, already_present: already, staples };
    },
  );

  const removePantryStaples = record(
    "remove_pantry_staples",
    "Remove items from the user's permanent pantry staples (they no longer keep it on hand, " +
      "so it should start appearing on grocery lists again).",
    z.object({ names: z.array(z.string().min(1)).min(1) }),
    async ({ names }) => {
      const removed: string[] = [];
      const notFound: string[] = [];
      for (const raw of names) {
        const name = raw.trim().toLowerCase();
        if (!name) continue;
        const r = await query("DELETE FROM pantry_staples WHERE lower(name) = $1", [name]);
        ((r.rowCount ?? 0) > 0 ? removed : notFound).push(name);
      }
      const staples = (
        await query<{ name: string }>("SELECT name FROM pantry_staples ORDER BY name")
      ).rows.map((r) => r.name);
      return { removed, not_found: notFound, staples };
    },
  );

  return [
    searchRecipes,
    getRecipe,
    createMealPlan,
    addRecipeToPlan,
    generateGroceryList,
    saveGroceryList,
    addPantryStaples,
    removePantryStaples,
  ] as BetaRunnableTool<unknown>[];
}
