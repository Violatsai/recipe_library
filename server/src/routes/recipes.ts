import { Router } from "express";
import { query } from "../db.js";
import { asyncHandler } from "../http.js";
import { fetchRecipeDetail, listRecipes } from "../recipeQueries.js";

export const recipesRouter = Router();

recipesRouter.get("/recipes", asyncHandler(async (_req, res) => {
  res.json(await listRecipes());
}));

recipesRouter.get("/recipes/:id", asyncHandler(async (req, res) => {
  const detail = await fetchRecipeDetail(req.params.id ?? "");
  if (!detail) {
    res.status(404).json({ error: "recipe not found" });
    return;
  }
  res.json(detail);
}));

recipesRouter.delete("/recipes/:id", asyncHandler(async (req, res) => {
  // FK cascades remove ingredients, recipe_tags, and meal_plan_recipes rows.
  const r = await query("DELETE FROM recipes WHERE id = $1", [req.params.id]);
  if (r.rowCount === 0) {
    res.status(404).json({ error: "recipe not found" });
    return;
  }
  res.json({ ok: true });
}));
