import { Router } from "express";
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
