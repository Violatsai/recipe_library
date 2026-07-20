import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** Shared core: embed → transactional upsert, given already-enriched data.
 *  `resolveSourceDetail` runs on the result so callers can set provenance
 *  from the result (e.g. which source Claude actually used). */
async function persist(args: {
  normalizedUrl: string;
  source: "web" | "youtube" | "photo";
  resolveSourceDetail: (data: EnrichmentData) => string | null;
  data: EnrichmentData;
  description: string;
  photoPath?: string | null;
}): Promise<IngestResult> {
  const data = args.data;
  const sourceDetail = args.resolveSourceDetail(data);
  const vector = await embedText(buildEmbedString(data), "document");
  const embLiteral = toVectorLiteral(vector);
  const macros = data.macros_per_serving;

  const { recipeId, inserted } = await withTransaction(async (client) => {
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
        sourceDetail,
        data.servings,
        data.total_time_min,
        JSON.stringify(data.steps),
        args.description,
        macros?.kcal ?? null,
        macros?.protein_g ?? null,
        macros?.carbs_g ?? null,
        macros?.fat_g ?? null,
        embLiteral,
        data.partial,
        args.photoPath ?? null,
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

/** Text-source convenience wrapper: enrich from text, then persist. */
async function enrichAndPersist(args: {
  normalizedUrl: string;
  source: "web" | "youtube";
  resolveSourceDetail: (data: EnrichmentData) => string | null;
  userContent: string;
}): Promise<IngestResult> {
  const approvedTags = await fetchApprovedTags();
  const data = await enrich({ approvedTags, userContent: args.userContent });
  return persist({
    normalizedUrl: args.normalizedUrl,
    source: args.source,
    resolveSourceDetail: args.resolveSourceDetail,
    data,
    description: args.userContent, // description = raw captured content, for re-extraction
  });
}

async function ingestWeb(input: IngestInput, normalizedUrl: string): Promise<IngestResult> {
  const html = await fetchPage(input.url, input.html); // may throw NeedsHtmlError → 422
  return enrichAndPersist({
    normalizedUrl,
    source: "web",
    resolveSourceDetail: () => null,
    userContent: pageContent(html, normalizedUrl),
  });
}

async function ingestYouTube(normalizedUrl: string): Promise<IngestResult> {
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

export async function ingest(input: IngestInput): Promise<IngestResult> {
  const normalizedUrl = normalizeUrl(input.url);
  const source = detectSource(input.url);
  return source === "youtube" ? ingestYouTube(normalizedUrl) : ingestWeb(input, normalizedUrl);
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

  const results: IngestResult[] = [];
  for (let i = 0; i < usable.length; i++) {
    const data = usable[i]!;
    const normalizedUrl = usable.length === 1 ? `photo:${hash}` : `photo:${hash}#${i}`;
    results.push(
      await persist({
        normalizedUrl,
        source: "photo",
        resolveSourceDetail: () => null,
        data,
        description: `Photo-extracted recipe (${filename})`,
        photoPath: filename,
      }),
    );
  }
  return results;
}
