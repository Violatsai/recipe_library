import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../db.js";
import { embedText, toVectorLiteral } from "./embed.js";
import { enrich, enrichFromImage, type ApprovedTags, type EnrichmentData } from "./enrich.js";
import { fetchPage, NeedsHtmlError } from "./fetchPage.js";
import { extractRecipeJsonLd } from "./jsonld.js";
import { detectSource, normalizeUrl, youtubeVideoId } from "./normalizeUrl.js";
import { extractReadable } from "./readable.js";
import { findRecipeLink, getTranscript, getVideoMeta } from "./youtube.js";

const UPLOADS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../uploads");

/** Thrown when a photo doesn't contain an extractable recipe (no ingredients, no steps). */
export class NotARecipeError extends Error {
  constructor() {
    super("no recipe could be extracted from this photo");
  }
}

/** Thrown when a text/video enrichment returns no recipe entries at all. */
export class NoRecipesExtractedError extends Error {
  constructor() {
    super("no recipe could be extracted from this source");
  }
}

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

export interface IngestPhotoInput {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

export interface IngestResult {
  status: "saved" | "updated";
  source: "web" | "youtube" | "photo";
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

export function buildEmbedString(d: EnrichmentData): string {
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

/** One enriched recipe waiting for embedding + atomic persistence. */
export interface PersistRecipeInput {
  normalizedUrl: string;
  source: "web" | "youtube" | "photo";
  resolveSourceDetail: (data: EnrichmentData) => string | null;
  data: EnrichmentData;
  description: string;
  photoPath?: string | null;
}

export interface RecipePersistenceDependencies {
  embed: (text: string, kind: "document") => Promise<number[]>;
  transaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
}

interface PreparedRecipe extends PersistRecipeInput {
  sourceDetail: string | null;
  embeddingLiteral: string;
}

/** Persist one already-prepared recipe using the caller's transaction. */
async function persistPreparedRecipe(
  client: PoolClient,
  args: PreparedRecipe,
): Promise<IngestResult> {
  const data = args.data;
  const macros = data.macros_per_serving;

  const upsert = await client.query<{ id: string; inserted: boolean }>(
    `INSERT INTO recipes
         (title, source_url, source_type, source_detail, servings, total_time_min,
          steps, description, kcal, protein_g, carbs_g, fat_g,
          embedding, extraction_partial, photo_path, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::vector,$14,$15, now())
       ON CONFLICT (source_url) DO UPDATE SET
         title=EXCLUDED.title, source_type=EXCLUDED.source_type,
         source_detail=EXCLUDED.source_detail, servings=EXCLUDED.servings,
         total_time_min=EXCLUDED.total_time_min, steps=EXCLUDED.steps,
         description=EXCLUDED.description, kcal=EXCLUDED.kcal,
         protein_g=EXCLUDED.protein_g, carbs_g=EXCLUDED.carbs_g, fat_g=EXCLUDED.fat_g,
         embedding=EXCLUDED.embedding, extraction_partial=EXCLUDED.extraction_partial,
         photo_path=EXCLUDED.photo_path, updated_at=now()
       RETURNING id, (xmax::text = '0') AS inserted`,
      [
        data.title,
        args.normalizedUrl,
        args.source,
        args.sourceDetail,
        data.servings,
        data.total_time_min,
        JSON.stringify(data.steps),
        args.description,
        macros?.kcal ?? null,
        macros?.protein_g ?? null,
        macros?.carbs_g ?? null,
        macros?.fat_g ?? null,
        args.embeddingLiteral,
        data.partial,
        args.photoPath ?? null,
    ],
  );
  const row = upsert.rows[0]!;
  const recipeId = row.id;

  // ingredients: delete + reinsert
  await client.query("DELETE FROM ingredients WHERE recipe_id=$1", [recipeId]);
  for (const ing of data.ingredients) {
    await client.query(
      "INSERT INTO ingredients (recipe_id, name, quantity, unit, raw_text) VALUES ($1,$2,$3,$4,$5)",
      [recipeId, ing.name, ing.quantity, ing.unit, ing.raw_text],
    );
  }

  // tags: assemble all (category,value) pairs, auto-approve unknowns, replace recipe_tags
  const pairs: { category: string; value: string }[] = [
    ...data.tags.cuisine.map((v) => ({ category: "cuisine", value: v })),
    ...data.tags.dish_type.map((v) => ({ category: "dish_type", value: v })),
    ...data.tags.dietary.map((v) => ({ category: "dietary", value: v })),
    ...data.new_tags,
  ];
  await client.query("DELETE FROM recipe_tags WHERE recipe_id=$1", [recipeId]);
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
        [recipeId, tagId],
      );
    }
  }

  return {
    status: row.inserted ? "saved" : "updated",
    source: args.source,
    normalizedUrl: args.normalizedUrl,
    recipeId,
    title: data.title,
    partial: data.partial,
  };
}

/**
 * Embed every recipe before opening a transaction, then persist the complete
 * source as one atomic batch. If any embedding or database statement fails,
 * no partial multi-recipe set is committed.
 */
export async function persistRecipesAtomically(
  inputs: PersistRecipeInput[],
  deps: RecipePersistenceDependencies = {
    embed: embedText,
    transaction: withTransaction,
  },
): Promise<IngestResult[]> {
  const prepared: PreparedRecipe[] = [];
  for (const input of inputs) {
    const vector = await deps.embed(buildEmbedString(input.data), "document");
    prepared.push({
      ...input,
      sourceDetail: input.resolveSourceDetail(input.data),
      embeddingLiteral: toVectorLiteral(vector),
    });
  }
  return deps.transaction(async (client) => {
    const results: IngestResult[] = [];
    for (const recipe of prepared) {
      results.push(await persistPreparedRecipe(client, recipe));
    }
    return results;
  });
}

/** The usable extraction(s) from a recipes[] response — drops empty entries
 *  unless ALL of them are empty, in which case keep the lone thin/partial one
 *  (matches the original single-recipe behavior of persisting a thin result
 *  rather than silently discarding it). */
function pickUsable(recipes: EnrichmentData[]): EnrichmentData[] {
  const usable = recipes.filter((d) => d.ingredients.length > 0 || d.steps.length > 0);
  return usable.length > 0 ? usable : recipes;
}

/** Text-source convenience wrapper: enrich from text, then persist one row
 *  per distinct recipe found — a page or video may bundle several (e.g. a
 *  roundup article, or a video that walks through multiple dishes). Same
 *  single-vs-suffixed dedup key convention as photos: the common single-recipe
 *  case keeps the plain normalizedUrl so re-saving still updates in place;
 *  multi-recipe sources suffix each row with `#<index>`. */
async function enrichAndPersist(args: {
  normalizedUrl: string;
  source: "web" | "youtube";
  resolveSourceDetail: (data: EnrichmentData) => string | null;
  userContent: string;
}): Promise<IngestResult[]> {
  const approvedTags = await fetchApprovedTags();
  const recipes = await enrich({ approvedTags, userContent: args.userContent });
  const list = pickUsable(recipes);
  if (list.length === 0) throw new NoRecipesExtractedError();

  return persistRecipesAtomically(
    list.map((data, i) => {
      const normalizedUrl = list.length === 1 ? args.normalizedUrl : `${args.normalizedUrl}#${i}`;
      return {
        normalizedUrl,
        source: args.source,
        resolveSourceDetail: args.resolveSourceDetail,
        data,
        description: args.userContent, // description = raw captured content, for re-extraction
      };
    }),
  );
}

async function ingestWeb(input: IngestInput, normalizedUrl: string): Promise<IngestResult[]> {
  const html = await fetchPage(input.url, input.html); // may throw NeedsHtmlError → 422
  return enrichAndPersist({
    normalizedUrl,
    source: "web",
    resolveSourceDetail: () => null,
    userContent: pageContent(html, normalizedUrl),
  });
}

async function ingestYouTube(normalizedUrl: string): Promise<IngestResult[]> {
  const videoId = youtubeVideoId(normalizedUrl);
  if (!videoId) throw new Error(`could not extract a video id from ${normalizedUrl}`);
  const meta = await getVideoMeta(videoId);
  const link = findRecipeLink(meta.description);

  // Try the linked page. Recipe JSON-LD → trust it directly (high confidence).
  // No markup → keep its readable text and let Claude decide below whether it's
  // the real recipe or an unrelated sponsor/shop page. (A binary JSON-LD gate
  // over-rejected legit recipe pages that simply lack schema markup.)
  let linkedPage: { url: string; text: string } | null = null;
  if (link) {
    try {
      const html = await fetchPage(link);
      const jsonld = extractRecipeJsonLd(html);
      if (jsonld) {
        return await enrichAndPersist({
          normalizedUrl,
          source: "youtube",
          resolveSourceDetail: () => link,
          userContent: jsonldContent(jsonld, link),
        });
      }
      const r = extractReadable(html, link);
      const text = `${r.title}\n\n${r.textContent}`.trim();
      if (text.length > 0) linkedPage = { url: link, text };
    } catch (err) {
      if (!(err instanceof NeedsHtmlError)) throw err;
      // unfetchable → treat as no linked page
    }
  }

  const transcript = await getTranscript(videoId);
  const videoBlock =
    `Channel: ${meta.channel}\n` +
    `Video title: ${meta.title}\n\n` +
    `Video description:\n${meta.description}\n\n` +
    (transcript ? `Video transcript:\n${transcript}` : `(No transcript available for this video.)`);

  // Both sources available → let Claude pick the authoritative one.
  if (linkedPage) {
    const page = linkedPage;
    const userContent =
      `Source: YouTube video ${normalizedUrl}\n\n` +
      `A recipe page was linked in the video description. Use it as the recipe source ONLY IF ` +
      `it is the recipe for THIS video's dish. If the linked page is an unrelated sponsor, shop, ` +
      `or generic page, IGNORE it and extract from the video content instead. Set source_used ` +
      `to "linked_page" or "video" accordingly.\n\n` +
      `=== LINKED PAGE (${page.url}) ===\n${page.text}\n\n` +
      `=== VIDEO ===\n${videoBlock}`;
    return enrichAndPersist({
      normalizedUrl,
      source: "youtube",
      resolveSourceDetail: (d) => (d.source_used === "linked_page" ? page.url : null),
      userContent,
    });
  }

  // Video-only: title + description + best-effort transcript.
  return enrichAndPersist({
    normalizedUrl,
    source: "youtube",
    resolveSourceDetail: () => null,
    userContent: `Source: YouTube video ${normalizedUrl}\n${videoBlock}`,
  });
}

export async function ingest(input: IngestInput): Promise<IngestResult[]> {
  const normalizedUrl = normalizeUrl(input.url);
  const source = detectSource(input.url);
  return source === "youtube" ? ingestYouTube(normalizedUrl) : ingestWeb(input, normalizedUrl);
}

export interface IngestPreviewResult {
  title: string;
  partial: boolean;
}

/** Enrichment only — no embed call, no DB write. Lets a caller (the
 *  extension, for platforms prone to capturing a stale/wrong page) show what
 *  was actually found before committing to a save. Web-only: the extension
 *  never needs this for YouTube, since there's no client-side HTML capture
 *  (and so no staleness risk) on that path. */
export async function previewIngest(input: IngestInput): Promise<IngestPreviewResult[]> {
  const normalizedUrl = normalizeUrl(input.url);
  const html = await fetchPage(input.url, input.html); // may throw NeedsHtmlError → 422
  const approvedTags = await fetchApprovedTags();
  const recipes = await enrich({ approvedTags, userContent: pageContent(html, normalizedUrl) });
  return pickUsable(recipes).map((d) => ({ title: d.title, partial: d.partial }));
}

const MEDIA_TYPE_EXT: Record<IngestPhotoInput["mediaType"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Photo-source: content-hash dedup (re-uploading the same photo updates in
 *  place, same as re-saving a URL), vision enrichment, persist the image
 *  alongside the recipe row(s) — a photo may contain more than one recipe
 *  (e.g. two recipes on one cookbook page), each becomes its own row sharing
 *  the same saved photo. Single-recipe photos keep the plain `photo:<hash>`
 *  key so re-uploading them still updates in place; once a photo yields more
 *  than one recipe each row gets a `#<index>` suffix to stay unique. */
export async function ingestPhoto(input: IngestPhotoInput): Promise<IngestResult[]> {
  const bytes = Buffer.from(input.imageBase64, "base64");
  const hash = createHash("sha256").update(bytes).digest("hex");

  const approvedTags = await fetchApprovedTags();
  const recipes = await enrichFromImage({ approvedTags, imageBase64: input.imageBase64, mediaType: input.mediaType });
  const usable = recipes.filter((d) => d.ingredients.length > 0 || d.steps.length > 0);
  if (usable.length === 0) {
    throw new NotARecipeError();
  }

  const ext = MEDIA_TYPE_EXT[input.mediaType];
  const filename = `${hash}.${ext}`;
  await mkdir(UPLOADS_DIR, { recursive: true });
  await writeFile(path.join(UPLOADS_DIR, filename), bytes);

  return persistRecipesAtomically(
    usable.map((data, i) => {
      const normalizedUrl = usable.length === 1 ? `photo:${hash}` : `photo:${hash}#${i}`;
      return {
        normalizedUrl,
        source: "photo" as const,
        resolveSourceDetail: () => null,
        data,
        description: `Photo-extracted recipe (${filename})`,
        photoPath: filename,
      };
    }),
  );
}
