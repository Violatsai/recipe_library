import { query } from "../db.js";
import { embedText, toVectorLiteral } from "../ingest/embed.js";
import { exclusionPatterns } from "./aliases.js";

/**
 * Hybrid search (ARCHITECTURE.md §03, Appendix B). Structured filters are hard
 * SQL constraints applied BEFORE ranking; the free-text query drives semantic
 * ordering via pgvector cosine distance. Exclusions/dietary are best-effort
 * (name + raw_text + allergen aliases), never left to embedding similarity.
 */

export interface SearchInput {
  query: string;
  must_have: string[];
  must_exclude: string[];
  cuisine: string[];
  dish_type: string[];
  dietary: string[];
  max_time_min: number | null;
  limit: number;
}

export interface SearchResult {
  id: string;
  title: string;
  cuisine: string[];
  dish_type: string[];
  total_time_min: number | null;
  macros: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; estimated: true } | null;
}

export interface SearchOutput {
  results: SearchResult[];
  /** false when the embedding service was unavailable — filters still applied, ordering by recency */
  semantic_ranking: boolean;
  note?: string;
}

interface RecipeRow {
  id: string;
  title: string;
  total_time_min: number | null;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}

export async function hybridSearch(input: SearchInput): Promise<SearchOutput> {
  const params: unknown[] = [];
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  const clauses: string[] = [];

  if (input.must_exclude.length > 0) {
    const pat = bind(exclusionPatterns(input.must_exclude));
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM ingredients i WHERE i.recipe_id = r.id
         AND (i.name ILIKE ANY(${pat}) OR i.raw_text ILIKE ANY(${pat})))`,
    );
  }

  if (input.must_have.length > 0) {
    const mh = bind(input.must_have);
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM unnest(${mh}::text[]) AS need(term)
         WHERE NOT EXISTS (SELECT 1 FROM ingredients i
                           WHERE i.recipe_id = r.id AND i.name ILIKE '%'||need.term||'%'))`,
    );
  }

  for (const [category, values] of [
    ["cuisine", input.cuisine],
    ["dish_type", input.dish_type],
    ["dietary", input.dietary],
  ] as const) {
    if (values.length > 0) {
      clauses.push(
        `EXISTS (SELECT 1 FROM recipe_tags rt JOIN tags t ON t.id = rt.tag_id
           WHERE rt.recipe_id = r.id AND t.category = ${bind(category)} AND t.value = ANY(${bind(values)}))`,
      );
    }
  }

  if (input.max_time_min != null) {
    clauses.push(`(r.total_time_min IS NOT NULL AND r.total_time_min <= ${bind(input.max_time_min)})`);
  }

  // Semantic ranking is best-effort: if the embedding service is down or
  // rate-limited (after embedText's own retries), degrade to the structured
  // filters ordered by recency rather than failing the whole search.
  let orderBy = "r.created_at DESC";
  let semanticRanking = false;
  let note: string | undefined;
  if (input.query.trim().length > 0) {
    try {
      const vec = await embedText(input.query, "query");
      orderBy = `r.embedding <=> ${bind(toVectorLiteral(vec))}::vector NULLS LAST, r.created_at DESC`;
      semanticRanking = true;
    } catch (err) {
      note =
        "semantic ranking unavailable (embedding service error) — filters were applied, results are ordered by recency";
      console.warn(`hybridSearch: degraded to recency ordering: ${err instanceof Error ? err.message : err}`);
    }
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT r.id, r.title, r.total_time_min, r.kcal, r.protein_g, r.carbs_g, r.fat_g
               FROM recipes r ${where}
               ORDER BY ${orderBy}
               LIMIT ${bind(input.limit)}`;

  const rows = (await query<RecipeRow>(sql, params)).rows;
  if (rows.length === 0) return { results: [], semantic_ranking: semanticRanking, ...(note && { note }) };

  // Attach cuisine/dish_type tags for the result set in one query.
  const ids = rows.map((r) => r.id);
  const tagRows = (
    await query<{ recipe_id: string; category: string; value: string }>(
      `SELECT rt.recipe_id, t.category, t.value
         FROM recipe_tags rt JOIN tags t ON t.id = rt.tag_id
         WHERE rt.recipe_id = ANY($1) AND t.category IN ('cuisine','dish_type')`,
      [ids],
    )
  ).rows;

  const tagMap = new Map<string, { cuisine: string[]; dish_type: string[] }>();
  for (const id of ids) tagMap.set(id, { cuisine: [], dish_type: [] });
  for (const tr of tagRows) {
    const entry = tagMap.get(tr.recipe_id);
    if (entry && (tr.category === "cuisine" || tr.category === "dish_type")) {
      entry[tr.category].push(tr.value);
    }
  }

  const results = rows.map((r) => ({
    id: r.id,
    title: r.title,
    cuisine: tagMap.get(r.id)?.cuisine ?? [],
    dish_type: tagMap.get(r.id)?.dish_type ?? [],
    total_time_min: r.total_time_min,
    macros:
      r.kcal == null
        ? null
        : {
            kcal: r.kcal,
            protein_g: r.protein_g ?? 0,
            carbs_g: r.carbs_g ?? 0,
            fat_g: r.fat_g ?? 0,
            estimated: true as const,
          },
  }));
  return { results, semantic_ranking: semanticRanking, ...(note && { note }) };
}
