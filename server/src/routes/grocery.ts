import { Router } from "express";
import { asyncHandler } from "../http.js";
import { z } from "zod";
import { scaleQuantity } from "../agent/tools.js";
import { query } from "../db.js";
import { REMINDERS_LIST_NAME, sendToReminders } from "../reminders.js";

export const groceryRouter = Router();

/** Push a grocery list's UNCHECKED items to Apple Reminders (iCloud → phone).
 *  User-initiated via a button click — the app's first outward action. */
groceryRouter.post("/grocery-lists/:id/send-to-reminders", asyncHandler(async (req, res) => {
  const items = (
    await query<{ name: string; quantity: number | null; unit: string | null; category: string | null }>(
      `SELECT name, quantity, unit, category FROM grocery_items
         WHERE grocery_list_id = $1 AND NOT checked
         ORDER BY category NULLS LAST, name`,
      [req.params.id],
    )
  ).rows;
  if (items.length === 0) {
    res.status(400).json({ error: "no unchecked items to send (is the list already done?)" });
    return;
  }
  const sent = await sendToReminders(
    items.map((i) => ({
      title: [i.name, i.quantity != null ? `${i.quantity}${i.unit ? ` ${i.unit}` : ""}` : i.unit ?? ""]
        .filter(Boolean)
        .join(" — "),
      section: i.category ?? "other",
    })),
  );
  res.json({ sent, list: REMINDERS_LIST_NAME });
}));

/** Items of one saved grocery list (with ids, so the UI can toggle checkboxes).
 *  Includes meal_plan_id so the UI can offer the per-recipe view of the same plan. */
groceryRouter.get("/grocery-lists/:id", asyncHandler(async (req, res) => {
  const list = (
    await query<{ meal_plan_id: string }>(
      "SELECT meal_plan_id FROM grocery_lists WHERE id = $1",
      [req.params.id],
    )
  ).rows[0];
  if (!list) {
    res.status(404).json({ error: "grocery list not found" });
    return;
  }
  const items = (
    await query<{
      id: string;
      name: string;
      quantity: number | null;
      unit: string | null;
      checked: boolean;
      category: string | null;
    }>(
      "SELECT id, name, quantity, unit, checked, category FROM grocery_items WHERE grocery_list_id = $1 ORDER BY category NULLS LAST, name",
      [req.params.id],
    )
  ).rows;
  res.json({ id: req.params.id, meal_plan_id: list.meal_plan_id, items });
}));

const Toggle = z.object({ checked: z.boolean() });

groceryRouter.patch("/grocery-items/:id", asyncHandler(async (req, res) => {
  const parsed = Toggle.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "checked (boolean) required" });
    return;
  }
  const r = await query("UPDATE grocery_items SET checked = $1 WHERE id = $2", [
    parsed.data.checked,
    req.params.id,
  ]);
  if (r.rowCount === 0) {
    res.status(404).json({ error: "item not found" });
    return;
  }
  res.json({ ok: true });
}));

/** All meal plans, newest first, with recipe count + latest grocery list. */
groceryRouter.get("/meal-plans", asyncHandler(async (_req, res) => {
  const rows = (
    await query<{
      id: string;
      title: string;
      start_date: string | null;
      created_at: string;
      recipe_count: string;
      latest_grocery_list_id: string | null;
    }>(
      `SELECT mp.id, mp.title, mp.start_date, mp.created_at,
              (SELECT count(*) FROM meal_plan_recipes mpr WHERE mpr.meal_plan_id = mp.id)::text AS recipe_count,
              (SELECT gl.id FROM grocery_lists gl WHERE gl.meal_plan_id = mp.id
                ORDER BY gl.created_at DESC LIMIT 1) AS latest_grocery_list_id
         FROM meal_plans mp
         ORDER BY mp.created_at DESC`,
    )
  ).rows;
  res.json(rows.map((r) => ({ ...r, recipe_count: Number(r.recipe_count) })));
}));

const PlanPatch = z
  .object({
    title: z.string().min(1).optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .refine((p) => p.title !== undefined || p.start_date !== undefined, {
    message: "provide title and/or start_date",
  });

/** Edit a plan's title and/or date (start_date: 'YYYY-MM-DD' or null to clear). */
groceryRouter.patch("/meal-plans/:id", asyncHandler(async (req, res) => {
  const parsed = PlanPatch.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (parsed.data.title !== undefined) {
    params.push(parsed.data.title);
    sets.push(`title = $${params.length}`);
  }
  if (parsed.data.start_date !== undefined) {
    params.push(parsed.data.start_date);
    sets.push(`start_date = $${params.length}`);
  }
  params.push(req.params.id);
  const r = await query(
    `UPDATE meal_plans SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params,
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "meal plan not found" });
    return;
  }
  res.json({ ok: true });
}));

/** Delete a plan (cascades to its grocery lists/items and plan entries). */
groceryRouter.delete("/meal-plans/:id", asyncHandler(async (req, res) => {
  const r = await query("DELETE FROM meal_plans WHERE id = $1", [req.params.id]);
  if (r.rowCount === 0) {
    res.status(404).json({ error: "meal plan not found" });
    return;
  }
  res.json({ ok: true });
}));

/** Per-recipe ingredient view: the plan's raw lines, scaled to planned servings,
 *  grouped by recipe. Derived (same math as generate_grocery_list) — read-only. */
groceryRouter.get("/meal-plans/:id/ingredients", asyncHandler(async (req, res) => {
  const rows = (
    await query<{
      recipe_id: string;
      title: string;
      planned: number | null;
      recipe_servings: number | null;
      name: string;
      quantity: number | null;
      unit: string | null;
    }>(
      `SELECT r.id AS recipe_id, r.title, mpr.servings AS planned,
              r.servings AS recipe_servings, i.name, i.quantity, i.unit
         FROM meal_plan_recipes mpr
         JOIN recipes r ON r.id = mpr.recipe_id
         JOIN ingredients i ON i.recipe_id = r.id
         WHERE mpr.meal_plan_id = $1
         ORDER BY r.title, i.name`,
      [req.params.id],
    )
  ).rows;
  const byRecipe = new Map<
    string,
    { recipe_id: string; title: string; servings: number | null; items: { name: string; quantity: number | null; unit: string | null }[] }
  >();
  for (const row of rows) {
    const key = `${row.recipe_id}:${row.planned ?? ""}`;
    let entry = byRecipe.get(key);
    if (!entry) {
      entry = {
        recipe_id: row.recipe_id,
        title: row.title,
        servings: row.planned ?? row.recipe_servings,
        items: [],
      };
      byRecipe.set(key, entry);
    }
    entry.items.push({
      name: row.name,
      quantity: scaleQuantity(row.quantity, row.planned, row.recipe_servings),
      unit: row.unit,
    });
  }
  res.json([...byRecipe.values()]);
}));

/** One meal plan with its recipes (for rendering the plan card in chat). */
groceryRouter.get("/meal-plans/:id", asyncHandler(async (req, res) => {
  const plan = (
    await query<{ id: string; title: string; start_date: string | null }>(
      "SELECT id, title, start_date FROM meal_plans WHERE id = $1",
      [req.params.id],
    )
  ).rows[0];
  if (!plan) {
    res.status(404).json({ error: "meal plan not found" });
    return;
  }
  const entries = (
    await query<{
      entry_id: string;
      recipe_id: string;
      title: string;
      day: string | null;
      meal_slot: string | null;
      servings: number | null;
    }>(
      `SELECT mpr.id AS entry_id, mpr.recipe_id, r.title, mpr.day, mpr.meal_slot, mpr.servings
         FROM meal_plan_recipes mpr JOIN recipes r ON r.id = mpr.recipe_id
         WHERE mpr.meal_plan_id = $1
         ORDER BY mpr.day NULLS LAST, mpr.meal_slot NULLS LAST, r.title`,
      [req.params.id],
    )
  ).rows;
  res.json({ ...plan, entries });
}));

const EntryPatch = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

/** Edit one plan entry's day ('YYYY-MM-DD' or null to clear). */
groceryRouter.patch("/meal-plan-recipes/:id", asyncHandler(async (req, res) => {
  const parsed = EntryPatch.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "day must be 'YYYY-MM-DD' or null" });
    return;
  }
  const r = await query("UPDATE meal_plan_recipes SET day = $1 WHERE id = $2", [
    parsed.data.day,
    req.params.id,
  ]);
  if (r.rowCount === 0) {
    res.status(404).json({ error: "plan entry not found" });
    return;
  }
  res.json({ ok: true });
}));
