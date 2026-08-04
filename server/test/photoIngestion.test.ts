import { describe, expect, it, vi } from "vitest";
import type { EnrichmentData } from "../src/ingest/enrich.js";
import {
  ingestPhoto,
  NotARecipeError,
  type PhotoIngestionDependencies,
} from "../src/ingest/pipeline.js";

const approvedTags = { cuisine: [], dish_type: [], dietary: [] };

function recipe(): EnrichmentData {
  return {
    title: "Invented Toast",
    servings: 1,
    total_time_min: 5,
    steps: ["Toast the bread."],
    ingredients: [{ name: "bread", quantity: 1, unit: "slice", raw_text: "1 slice bread" }],
    defining_ingredients: ["bread"],
    tags: { cuisine: [], dish_type: [], dietary: [] },
    new_tags: [],
    macros_per_serving: null,
    partial: false,
    source_used: null,
  };
}

function dependencies(
  extraction: Awaited<ReturnType<PhotoIngestionDependencies["enrichImage"]>>,
): PhotoIngestionDependencies {
  return {
    fetchApprovedTags: vi.fn(async () => approvedTags),
    enrichImage: vi.fn(async () => extraction),
    saveImage: vi.fn(async () => undefined),
    persist: vi.fn(async () => []),
  };
}

const input = {
  imageBase64: Buffer.from("not really an image").toString("base64"),
  mediaType: "image/jpeg" as const,
};

describe("non-recipe photo ingestion", () => {
  it("rejects a non-recipe classification before saving a file or recipe", async () => {
    // Reproduce the dangerous contradictory response: the model classifies the
    // image as unrelated but still emits a plausible recipe. The classification
    // must win so no downstream write can occur.
    const deps = dependencies({ containsRecipe: false, recipes: [recipe()] });

    await expect(ingestPhoto(input, deps)).rejects.toBeInstanceOf(NotARecipeError);
    expect(deps.saveImage).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("rejects an empty extraction even if its classification is inconsistent", async () => {
    const deps = dependencies({ containsRecipe: true, recipes: [] });

    await expect(ingestPhoto(input, deps)).rejects.toThrow(
      "No recipe found in this image. Try a clear photo that includes visible ingredients or instructions.",
    );
    expect(deps.saveImage).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("keeps valid photo ingestion synchronous", async () => {
    const deps = dependencies({ containsRecipe: true, recipes: [recipe()] });
    const result = [{
      status: "saved" as const,
      source: "photo" as const,
      normalizedUrl: "photo:test",
      recipeId: "recipe-id",
      title: "Invented Toast",
      partial: false,
    }];
    (deps.persist as ReturnType<typeof vi.fn>).mockResolvedValueOnce(result);

    await expect(ingestPhoto(input, deps)).resolves.toEqual(result);
    expect(deps.saveImage).toHaveBeenCalledOnce();
    expect(deps.persist).toHaveBeenCalledOnce();
  });
});
