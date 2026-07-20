import { query } from "./db.js";

/**
 * Shared recipe read queries — used by both the agent's get_recipe tool and
 * the REST routes, so the chat UI and library screen render the same shape.
 */

export interface RecipeSummary {
  id: string;
  title: string;
  source_type: string;
  total_time_min: number | null;
  kcal: number | null;
  extraction_partial: boolean;
  created_at: string;
  tags: { category: string; value: string }[];
  /** normalized ingredient names — lets the library search match by contents */
  ingredient_names: string[];
}

export interface RecipeDetail {
  id: string;
  title: string;
  servings: number | null;
  total_time_min: number | null;
  steps: unknown;
  ingredients: { name: string; quantity: number | null; unit: string | null; raw_text: string }[];
  tags: { category: string; value: string }[];
  macros_per_serving: { kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null } | null;
  macros_estimated: boolean;
  extraction_partial: boolean;
  source_type: string;
  source_url: string;
  source_detail: string | null;
  photo_path: string | null;
}

export async function listRecipes(): Promise<RecipeSummary[]> {
  const rows = (
    await query<{
      id: string;
      title: string;
      source_type: string;
      total_time_min: number | null;
      kcal: number | null;
      extraction_partial: boolean;
      created_at: string;
      ingredient_names: string[];
    }>(
      `SELECT r.id, r.title, r.source_type, r.total_time_min, r.kcal, r.extraction_partial,
              r.created_at,
              coalesce(
                (SELECT array_agg(DISTINCT i.name) FROM ingredients i WHERE i.recipe_id = r.id),
                '{}'
              ) AS ingredient_names
         FROM recipes r ORDER BY r.created_at DESC`,
    )
  ).rows;
  if (rows.length === 0) return [];

  const tagRows = (
    await query<{ recipe_id: string; category: string; value: string }>(
      `SELECT rt.recipe_id, t.category, t.value
         FROM recipe_tags rt JOIN tags t ON t.id = rt.tag_id
         WHERE rt.recipe_id = ANY($1)
         ORDER BY t.category, t.value`,
      [rows.map((r) => r.id)],
    )
  ).rows;
  const tagMap = new Map<string, { category: string; value: string }[]>();
  for (const tr of tagRows) {
    const list = tagMap.get(tr.recipe_id) ?? [];
    list.push({ category: tr.category, value: tr.value });
    tagMap.set(tr.recipe_id, list);
  }
  return rows.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] }));
}

export async function fetchRecipeDetail(id: string): Promise<RecipeDetail | null> {
  const r = (
    await query<{
      id: string;
      title: string;
      servings: number | null;
      total_time_min: number | null;
      steps: unknown;
      kcal: number | null;
      protein_g: number | null;
      carbs_g: number | null;
      fat_g: number | null;
      macros_estimated: boolean;
      extraction_partial: boolean;
      source_type: string;
      source_url: string;
      source_detail: string | null;
      photo_path: string | null;
    }>(
      `SELECT id, title, servings, total_time_min, steps, kcal, protein_g, carbs_g, fat_g,
              macros_estimated, extraction_partial, source_type, source_url, source_detail, photo_path
         FROM recipes WHERE id = $1`,
      [id],
    )
  ).rows[0];
  if (!r) return null;

  const ingredients = (
    await query<{ name: string; quantity: number | null; unit: string | null; raw_text: string }>(
      "SELECT name, quantity, unit, raw_text FROM ingredients WHERE recipe_id = $1 ORDER BY name",
      [id],
    )
  ).rows;
  const tags = (
    await query<{ category: string; value: string }>(
      `SELECT t.category, t.value FROM recipe_tags rt JOIN tags t ON t.id = rt.tag_id
         WHERE rt.recipe_id = $1 ORDER BY t.category, t.value`,
      [id],
    )
  ).rows;

  return {
    id: r.id,
    title: r.title,
    servings: r.servings,
    total_time_min: r.total_time_min,
    steps: r.steps,
    ingredients,
    tags,
    macros_per_serving:
      r.kcal == null
        ? null
        : { kcal: r.kcal, protein_g: r.protein_g, carbs_g: r.carbs_g, fat_g: r.fat_g },
    macros_estimated: r.macros_estimated,
    extraction_partial: r.extraction_partial,
    source_type: r.source_type,
    source_url: r.source_url,
    source_detail: r.source_detail,
    photo_path: r.photo_path,
  };
}
