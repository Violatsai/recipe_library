import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// zod v4 schema API (ships inside zod 3.25 under this subpath). zodOutputFormat
// requires the v4-style ZodType, so the schema fed to it must come from here.
import { z } from "zod/v4";
import { config } from "../config.js";

/**
 * The single Claude enrichment pass. Given clean structured input (schema.org
 * Recipe JSON) or article/transcript text, returns the full structured record:
 * extraction + controlled-vocabulary tags + defining ingredients + ballpark
 * macros, all in one call. Arithmetic for macros is done in-context (no
 * code_execution) — the per-ingredient estimates dwarf any rounding error.
 */

// Appendix A schema. All fields the pipeline persists.
export const Enrichment = z.object({
  title: z.string(),
  servings: z.number().int().nullable(),
  total_time_min: z.number().int().nullable(),
  steps: z.array(z.string()),
  ingredients: z.array(
    z.object({
      name: z.string(), // normalized, lowercase: "garlic"
      quantity: z.number().nullable(),
      unit: z.string().nullable(),
      raw_text: z.string(), // verbatim source line
    }),
  ),
  defining_ingredients: z.array(z.string()), // subset of ingredient names
  tags: z.object({
    cuisine: z.array(z.string()),
    dish_type: z.array(z.string()),
    dietary: z.array(z.string()),
  }),
  new_tags: z.array(
    z.object({
      category: z.enum(["cuisine", "dish_type", "dietary"]),
      value: z.string(),
    }),
  ),
  macros_per_serving: z
    .object({
      kcal: z.number(),
      protein_g: z.number(),
      carbs_g: z.number(),
      fat_g: z.number(),
    })
    .nullable(),
  partial: z.boolean(),
  // Only meaningful when the input offers BOTH a linked page and video content
  // (YouTube). Records which one the recipe was extracted from, for provenance.
  // null in every other case.
  source_used: z.enum(["linked_page", "video"]).nullable(),
});

export type EnrichmentData = z.infer<typeof Enrichment>;

export interface ApprovedTags {
  cuisine: string[];
  dish_type: string[];
  dietary: string[];
}

export interface EnrichContext {
  approvedTags: ApprovedTags;
  /** Fully-formed source content (URL header + JSON-LD or article/transcript text). */
  userContent: string;
}

function SHARED_RULES(vocab: ApprovedTags): string {
  return `- title, servings, total_time_min, and ordered steps.
- Recipes may be in ANY language. Regardless of source language: ingredients "name" and defining_ingredients are ALWAYS normalized lowercase ENGLISH (translate; keep culturally specific items romanized, e.g. "doubanjiang", "miso"); "raw_text" stays VERBATIM in the source language. For non-English sources, write each step in the source language followed by an English translation in parentheses. Parse quantities from source-language units (e.g. 半茶匙 → 0.5 tsp).
- title: the PLAIN DISH NAME only. Strip channel/series/creator names, publication or video branding, episode markers, and decorations like "…做法" or a trailing "Recipe". Use the name an English-speaking cook would naturally call the dish — often the romanized native name itself ("Pad Thai", "Carbonara"). If the source title is in a NON-LATIN script, give the original dish name (decorations stripped) followed by the English name in parentheses, e.g. 茄香四季豆 (Tomato-Scented Green Beans). Only simplify clear redundancy or branding; never reword genuinely descriptive titles.
- ingredients: "name" is the normalized lowercase ingredient (e.g. "garlic"); parse "quantity" and "unit" when present (null when there is none, e.g. "a pinch"); "raw_text" is the original line, verbatim.
- If a recipe lists ingredients under multiple sub-components (e.g. "Salmon" and "Avocado & Mango Salsa"), list each ingredient ONCE: when the same ingredient appears in more than one component with the SAME amount (including both being vague/"to taste"), include only one entry for it. Only keep separate entries when the amounts genuinely differ between components (e.g. ½ tsp salt in the marinade vs a pinch in the dressing) — never sum or guess a combined amount in that case, just list both as they appear.
- defining_ingredients: the subset of ingredient names that CHARACTERIZE the dish — distinctive proteins, flavor bases, or components (e.g. "miso", "gochujang", "salmon"). Exclude ubiquitous staples (salt, water, oil, sugar, flour) even when present. Choose by distinctiveness, NOT quantity: a small amount of a defining ingredient still counts.
- tags: classify into the APPROVED VOCABULARY below, using ONLY values from these lists. A recipe may have several cuisine/dietary tags, or none. Infer dietary tags from the ingredients (e.g. no meat or fish -> vegetarian; also vegan / gluten-free / dairy-free when the ingredients clearly support it).
- new_tags: ONLY when no approved value fits a classification the recipe genuinely needs. Propose a concise value in the correct category. Never duplicate an approved value here.
- macros_per_serving: a BALLPARK per-serving estimate (kcal, protein_g, carbs_g, fat_g), reasoned from the ingredients and servings. Approximate is expected. Use null only when there is not enough information at all.
- partial: true when the source was too thin to extract a confident recipe (missing ingredients or steps).
- source_used: ONLY when the input below contains both a "LINKED PAGE" section and a "VIDEO" section, set this to "linked_page" if you extracted the recipe from the linked page, or "video" if the linked page was unrelated (a sponsor/shop/generic page) and you used the video's description/transcript instead. In every other case set it to null.

APPROVED VOCABULARY
cuisine: ${vocab.cuisine.join(", ")}
dish_type: ${vocab.dish_type.join(", ")}
dietary: ${vocab.dietary.join(", ")}`;
}

function systemPrompt(vocab: ApprovedTags): string {
  return `You extract structured recipe data from a source — either a schema.org Recipe JSON object or article/transcript text — and return it in the required format.

Rules:
${SHARED_RULES(vocab)}
- The source may describe ONE recipe or SEVERAL distinct recipes (e.g. a "5 recipes" roundup article, or a video that walks through multiple dishes). Extract EVERY distinct recipe as a separate entry in the "recipes" array — do not merge them and do not drop any for being shorter or less prominent.`;
}

function imageSystemPrompt(vocab: ApprovedTags): string {
  return `You extract structured recipe data from a PHOTO of one or more recipes — a cookbook page, handwritten card, printed clipping, or a screenshot — and return each recipe you find in the required format.

Rules:
${SHARED_RULES(vocab)}
- Read the image carefully, including handwriting, stylized fonts, and text at an angle or partially obscured. If part of the image is illegible, do your best from context (e.g. typical proportions for that dish) rather than leaving a field empty, but set partial: true if entire sections (all ingredients, or all steps) are unreadable.
- The photo may show ONE recipe or SEVERAL distinct recipes (e.g. two recipes on the same cookbook page). Extract EVERY distinct recipe visible as a separate entry in the "recipes" array — do not merge them and do not drop any for being less prominent. A recipe's photo/illustration on the page is not itself a recipe to extract.`;
}

const EnrichmentList = z.object({
  recipes: z.array(Enrichment),
});

export interface EnrichImageContext {
  approvedTags: ApprovedTags;
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

/** Returns one entry per distinct recipe found in the source (usually one). */
export async function enrich(ctx: EnrichContext): Promise<EnrichmentData[]> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const message = await client.messages.parse({
    model: "claude-sonnet-5",
    // Higher than a single recipe needs: a roundup article or multi-dish video
    // can pack several recipes' worth of bilingual steps/ingredients into one response.
    max_tokens: 16384,
    system: systemPrompt(ctx.approvedTags),
    messages: [{ role: "user", content: ctx.userContent }],
    output_config: { format: zodOutputFormat(EnrichmentList) },
  });
  if (!message.parsed_output) {
    throw new Error(`enrichment produced no parseable output (stop_reason: ${message.stop_reason})`);
  }
  return message.parsed_output.recipes;
}

/** Returns one entry per distinct recipe found in the photo (usually one). */
export async function enrichFromImage(ctx: EnrichImageContext): Promise<EnrichmentData[]> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const message = await client.messages.parse({
    model: "claude-sonnet-5",
    // Higher than the single-recipe text path's 8192: a photo can hold several
    // recipes' worth of bilingual steps/ingredients in one response.
    max_tokens: 16384,
    system: imageSystemPrompt(ctx.approvedTags),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: ctx.mediaType, data: ctx.imageBase64 },
          },
          {
            type: "text",
            text: "Extract every recipe from this photo.",
          },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(EnrichmentList) },
  });
  if (!message.parsed_output) {
    throw new Error(`enrichment produced no parseable output (stop_reason: ${message.stop_reason})`);
  }
  return message.parsed_output.recipes;
}
