import { query, withTransaction } from "../db.js";
import { embedText, toVectorLiteral } from "./embed.js";
import { enrich, type ApprovedTags, type EnrichmentData } from "./enrich.js";
import { fetchPage, NeedsHtmlError } from "./fetchPage.js";
import { extractRecipeJsonLd } from "./jsonld.js";
import { detectSource, normalizeUrl, youtubeVideoId } from "./normalizeUrl.js";
import { extractReadable } from "./readable.js";
import { findRecipeLink, getTranscript, getVideoMeta } from "./youtube.js";

/**
 * Ingestion orchestrator. Both source types funnel into one shared
 * enrich → embed → transactional-upsert core; they differ only in how the
 * enrichment input is assembled:
 *
 *   web      — fetch page (or use provided html) → JSON-LD or readability
 *   youtube  — Data API meta → recipe link in description?
 *                yes → fetch that page, same treatment as web
 *                      (fetch failure falls back to the transcript branch,
 *                       never NEEDS_HTML — the extension only sends a URL
 *                       for YouTube tabs)
 *                no  → title + description + best-effort transcript
 *
 * Dedup: upsert on normalized source_url; re-saving updates in place.
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

function jsonldContent(jsonld: Record<string, unknown>, url: string): string {
  return `Source URL: ${url}\n\nschema.org Recipe JSON:\n${JSON.stringify(jsonld)}`;
}

/** Build enrichment input from a recipe web page's HTML. */
function pageContent(html: string, url: string): string {
  const jsonld = extractRecipeJsonLd(html);
  if (jsonld) return jsonldContent(jsonld, url);
  const r = extractReadable(html, url);
  return `Source URL: ${url}\n\nArticle title: ${r.title}\n\nArticle text:\n${r.textContent}`;
}

/** Shared core: enrich → embed → transactional upsert. */
async function enrichAndPersist(args: {
  normalizedUrl: string;
  source: "web" | "youtube";
  sourceDetail: string | null;
  userContent: string;
}): Promise<IngestResult> {
  const approvedTags = await fetchApprovedTags();
  const data = await enrich({ approvedTags, userContent: args.userContent });
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
        args.normalizedUrl,
        args.source,
        args.sourceDetail,
        data.servings,
        data.total_time_min,
        JSON.stringify(data.steps),
        args.userContent, // description = raw captured content, for re-extraction
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
    source: args.source,
    normalizedUrl: args.normalizedUrl,
    recipeId,
    title: data.title,
    partial: data.partial,
  };
}

async function ingestWeb(input: IngestInput, normalizedUrl: string): Promise<IngestResult> {
  const html = await fetchPage(input.url, input.html); // may throw NeedsHtmlError → 422
  return enrichAndPersist({
    normalizedUrl,
    source: "web",
    sourceDetail: null,
    userContent: pageContent(html, normalizedUrl),
  });
}

async function ingestYouTube(normalizedUrl: string): Promise<IngestResult> {
  const videoId = youtubeVideoId(normalizedUrl);
  if (!videoId) throw new Error(`could not extract a video id from ${normalizedUrl}`);
  const meta = await getVideoMeta(videoId);

  // Branch 1: recipe link in the description → extract from that page, but
  // ONLY if it carries Recipe JSON-LD. Descriptions are full of sponsor/merch
  // links a heuristic can't reliably reject; a page that 200s without Recipe
  // JSON-LD (e.g. a sponsor homepage) must not be trusted as the recipe
  // source, while real recipe pages nearly always embed it. Rejected or
  // unfetchable links fall through to the transcript branch, which is always
  // about the correct video.
  const link = findRecipeLink(meta.description);
  if (link) {
    try {
      const html = await fetchPage(link);
      const jsonld = extractRecipeJsonLd(html);
      if (jsonld) {
        return await enrichAndPersist({
          normalizedUrl,
          source: "youtube",
          sourceDetail: link,
          userContent: jsonldContent(jsonld, link),
        });
      }
      // no Recipe JSON-LD → unverified page → transcript branch
    } catch (err) {
      if (!(err instanceof NeedsHtmlError)) throw err;
      // linked page unfetchable server-side → transcript branch
    }
  }

  // Branch 2: title + description + best-effort transcript.
  const transcript = await getTranscript(videoId);
  const userContent =
    `Source: YouTube video ${normalizedUrl}\n` +
    `Channel: ${meta.channel}\n` +
    `Video title: ${meta.title}\n\n` +
    `Video description:\n${meta.description}\n\n` +
    (transcript
      ? `Video transcript:\n${transcript}`
      : `(No transcript available for this video.)`);
  return enrichAndPersist({
    normalizedUrl,
    source: "youtube",
    // source_detail means "the page we actually extracted from" — a rejected
    // or unfetchable link is not that, so the transcript branch stores none.
    sourceDetail: null,
    userContent,
  });
}

export async function ingest(input: IngestInput): Promise<IngestResult> {
  const normalizedUrl = normalizeUrl(input.url);
  const source = detectSource(input.url);
  return source === "youtube" ? ingestYouTube(normalizedUrl) : ingestWeb(input, normalizedUrl);
}
