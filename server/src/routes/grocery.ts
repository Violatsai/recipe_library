import { Router } from "express";
import { asyncHandler } from "../http.js";
import { z } from "zod";
import { query } from "../db.js";

export const groceryRouter = Router();

/** Items of one saved grocery list (with ids, so the UI can toggle checkboxes). */
groceryRouter.get("/grocery-lists/:id", asyncHandler(async (req, res) => {
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
  res.json({ id: req.params.id, items });
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
    await query<{ recipe_id: string; title: string; day: string | null; meal_slot: string | null; servings: number | null }>(
      `SELECT mpr.recipe_id, r.title, mpr.day, mpr.meal_slot, mpr.servings
         FROM meal_plan_recipes mpr JOIN recipes r ON r.id = mpr.recipe_id
         WHERE mpr.meal_plan_id = $1
         ORDER BY mpr.day NULLS LAST, mpr.meal_slot NULLS LAST, r.title`,
      [req.params.id],
    )
  ).rows;
  res.json({ ...plan, entries });
}));
