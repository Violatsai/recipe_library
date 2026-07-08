import { Router } from "express";
import { fetchRecipeDetail, listRecipes } from "../recipeQueries.js";

export const recipesRouter = Router();

recipesRouter.get("/recipes", async (_req, res) => {
  res.json(await listRecipes());
});

recipesRouter.get("/recipes/:id", async (req, res) => {
  const detail = await fetchRecipeDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: "recipe not found" });
    return;
  }
  res.json(detail);
});
