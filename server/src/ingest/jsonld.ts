import { JSDOM } from "jsdom";

/**
 * Find a schema.org/Recipe node in a page's JSON-LD. Recipe blogs commonly
 * embed one (often nested inside an @graph array), which gives the enrichment
 * step clean structured input instead of raw article text. Returns the raw
 * Recipe node, or null when the page has none.
 */

function findRecipe(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipe(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj["@graph"]) {
      const found = findRecipe(obj["@graph"]);
      if (found) return found;
    }
    const type = obj["@type"];
    if (type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))) {
      return obj;
    }
  }
  return null;
}

export function extractRecipeJsonLd(html: string): Record<string, unknown> | null {
  const { document } = new JSDOM(html).window;
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue; // malformed block — skip, try the next
    }
    const found = findRecipe(parsed);
    if (found) return found;
  }
  return null;
}
