import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractRecipeJsonLd } from "../src/ingest/jsonld.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("extractRecipeJsonLd", () => {
  it("finds a Recipe nested inside @graph", () => {
    const recipe = extractRecipeJsonLd(read("recipe-jsonld.html"));
    expect(recipe).not.toBeNull();
    expect(recipe?.["@type"]).toBe("Recipe");
    expect(recipe?.["name"]).toBe("Miso-Glazed Eggplant");
    expect(Array.isArray(recipe?.["recipeIngredient"])).toBe(true);
  });

  it("returns null when the page has no Recipe JSON-LD", () => {
    expect(extractRecipeJsonLd(read("recipe-plain.html"))).toBeNull();
  });

  it("returns null (not throw) on malformed JSON-LD blocks", () => {
    const html = '<script type="application/ld+json">{ not valid json </script>';
    expect(extractRecipeJsonLd(html)).toBeNull();
  });
});
