import { query, withTransaction } from "../db.js";
import { embedText, toVectorLiteral } from "./embed.js";
import { enrich, type ApprovedTags, type EnrichmentData } from "./enrich.js";
import { fetchPage } from "./fetchPage.js";
import { extractRecipeJsonLd } from "./jsonld.js";
import { detectSource, normalizeUrl } from "./normalizeUrl.js";
import { extractReadable } from "./readable.js";

/**
 * Ingestion orchestrator (M3 = web path): fetch → JSON-LD or readability →
 * enrich (Claude) → embed (Voyage) → transactional upsert. Deduped by
 * normalized source_url: re-saving updates the existing row in place.
 * M4 adds the YouTube branch.
 */

export interface IngestInput {
  url: string;
  html?: string;
}

export interface IngestResult {
  status: "saved" | "updated";
  source: "web" | "youtube";
  normalizedUrl: string;
  recipeId: string;
  title: string;
  partial: boolean;
}

async function fetchApprovedTags(): Promise<ApprovedTags> {
  const r = await query<{ category: string; value: string }>(
    "SELECT category, value FROM tags WHERE status = 'approved'",
  );
  const out: ApprovedTags = { cuisine: [], dish_type: [], dietary: [] };
  for (const row of r.rows) {
    if (row.category === "cuisine" || row.category === "dish_type" || row.category === "dietary") {
      out[row.category].push(row.value);
    }
  }
  return out;
}

function buildEmbedString(d: EnrichmentData): string {
  const defs = d.defining_ingredients.join(", ");
  const tagParts = [
    ...d.tags.cuisine.map((v) => `Cuisine: ${v}`),
    ...d.tags.dish_type.map((v) => `Dish: ${v}`),
    ...d.tags.dietary.map((v) => `Dietary: ${v}`),
  ].join(". ");
  return `${d.title}. Ingredients: ${defs}. ${tagParts}`;
}

export async function ingest(input: IngestInput): Promise<IngestResult> {
  const normalizedUrl = normalizeUrl(input.url);
  const source = detectSource(input.url);
  if (source === "youtube") {
    throw new Error("YouTube ingestion is implemented in M4");
  }

  const html = await fetchPage(input.url, input.html); // may throw NeedsHtmlError
  const jsonld = extractRecipeJsonLd(html);
  const approvedTags = await fetchApprovedTags();

  let userContent: string;
  if (jsonld) {
    userContent = `Source URL: ${normalizedUrl}\n\nschema.org Recipe JSON:\n${JSON.stringify(jsonld)}`;
  } else {
    const r = extractReadable(html, input.url);
    userContent = `Source URL: ${normalizedUrl}\n\nArticle title: ${r.title}\n\nArticle text:\n${r.textContent}`;
  }

  const data = await enrich({ approvedTags, userContent });
  const vector = await embedText(buildEmbedString(data), "document");
  const embLiteral = toVectorLiteral(vector);
  const macros = data.macros_per_serving;

  const { recipeId, inserted } = await withTransaction(async (client) => {
    const upsert = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO recipes
         (title, source_url, source_type, source_detail, servings, total_time_min,
          steps, description, kcal, protein_g, carbs_g, fat_g,
          embedding, extraction_partial, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::vector,$14, now())
       ON CONFLICT (source_url) DO UPDATE SET
         title=EXCLUDED.title, source_type=EXCLUDED.source_type,
         source_detail=EXCLUDED.source_detail, servings=EXCLUDED.servings,
         total_time_min=EXCLUDED.total_time_min, steps=EXCLUDED.steps,
         description=EXCLUDED.description, kcal=EXCLUDED.kcal,
         protein_g=EXCLUDED.protein_g, carbs_g=EXCLUDED.carbs_g, fat_g=EXCLUDED.fat_g,
         embedding=EXCLUDED.embedding, extraction_partial=EXCLUDED.extraction_partial,
         updated_at=now()
       RETURNING id, (xmax::text = '0') AS inserted`,
      [
        data.title,
        normalizedUrl,
        source,
        null, // source_detail — web recipes have none
        data.servings,
        data.total_time_min,
        JSON.stringify(data.steps),
        userContent, // description = raw captured content, for re-extraction
        macros?.kcal ?? null,
        macros?.protein_g ?? null,
        macros?.carbs_g ?? null,
        macros?.fat_g ?? null,
        embLiteral,
        data.partial,
      ],
    );
    const row = upsert.rows[0]!;
    const rid = row.id;

    // ingredients: delete + reinsert
    await client.query("DELETE FROM ingredients WHERE recipe_id=$1", [rid]);
    for (const ing of data.ingredients) {
      await client.query(
        "INSERT INTO ingredients (recipe_id, name, quantity, unit, raw_text) VALUES ($1,$2,$3,$4,$5)",
        [rid, ing.name, ing.quantity, ing.unit, ing.raw_text],
      );
    }

    // tags: assemble all (category,value) pairs, auto-approve unknowns, replace recipe_tags
    const pairs: { category: string; value: string }[] = [
      ...data.tags.cuisine.map((v) => ({ category: "cuisine", value: v })),
      ...data.tags.dish_type.map((v) => ({ category: "dish_type", value: v })),
      ...data.tags.dietary.map((v) => ({ category: "dietary", value: v })),
      ...data.new_tags,
    ];
    await client.query("DELETE FROM recipe_tags WHERE recipe_id=$1", [rid]);
    for (const p of pairs) {
      await client.query(
        "INSERT INTO tags (category, value) VALUES ($1,$2) ON CONFLICT (category, value) DO NOTHING",
        [p.category, p.value],
      );
      const t = await client.query<{ id: string }>(
        "SELECT id FROM tags WHERE category=$1 AND value=$2",
        [p.category, p.value],
      );
      const tagId = t.rows[0]?.id;
      if (tagId) {
        await client.query(
          "INSERT INTO recipe_tags (recipe_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [rid, tagId],
        );
      }
    }

    return { recipeId: rid, inserted: row.inserted };
  });

  return {
    status: inserted ? "saved" : "updated",
    source,
    normalizedUrl,
    recipeId,
    title: data.title,
    partial: data.partial,
  };
}
