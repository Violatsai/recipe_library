/**
 * Best-effort allergen alias expansion for must_exclude (Appendix C).
 * A user exclusion term is matched against ingredient name AND raw_text; if the
 * term is a key here, its aliases are matched too. Terms not in the map are
 * used as-is. This widens coverage (peanut → satay) but is NOT a guarantee —
 * the agent reminds the user to verify via the recipe's source link.
 */
export const ALLERGEN_ALIASES: Record<string, string[]> = {
  peanut: ["peanuts", "groundnut", "satay", "peanut butter"],
  tree_nut: ["almond", "cashew", "walnut", "pecan", "pistachio", "hazelnut", "macadamia"],
  gluten: ["wheat", "flour", "soy sauce", "barley", "rye", "panko", "breadcrumb"],
  dairy: ["milk", "butter", "cream", "cheese", "yogurt", "ghee"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "oyster", "clam", "mussel", "scallop"],
  egg: ["eggs", "mayonnaise", "mayo", "aioli"],
  soy: ["soybean", "tofu", "edamame", "soy sauce", "miso", "tempeh"],
  sesame: ["tahini", "sesame oil", "sesame seeds"],
};

/** Expand a list of exclusion terms into ILIKE patterns (term + any aliases). */
export function exclusionPatterns(terms: string[]): string[] {
  const patterns: string[] = [];
  for (const term of terms) {
    patterns.push(`%${term}%`);
    for (const alias of ALLERGEN_ALIASES[term.toLowerCase()] ?? []) {
      patterns.push(`%${alias}%`);
    }
  }
  return patterns;
}
