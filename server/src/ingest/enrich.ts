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

function systemPrompt(vocab: ApprovedTags): string {
  return `You extract structured recipe data from a source — either a schema.org Recipe JSON object or article/transcript text — and return it in the required format.

Rules:
- title, servings, total_time_min, and ordered steps.
- ingredients: "name" is the normalized lowercase ingredient (e.g. "garlic"); parse "quantity" and "unit" when present (null when there is none, e.g. "a pinch"); "raw_text" is the original line, verbatim.
- defining_ingredients: the subset of ingredient names that CHARACTERIZE the dish — distinctive proteins, flavor bases, or components (e.g. "miso", "gochujang", "salmon"). Exclude ubiquitous staples (salt, water, oil, sugar, flour) even when present. Choose by distinctiveness, NOT quantity: a small amount of a defining ingredient still counts.
- tags: classify into the APPROVED VOCABULARY below, using ONLY values from these lists. A recipe may have several cuisine/dietary tags, or none. Infer dietary tags from the ingredients (e.g. no meat or fish -> vegetarian; also vegan / gluten-free / dairy-free when the ingredients clearly support it).
- new_tags: ONLY when no approved value fits a classification the recipe genuinely needs. Propose a concise value in the correct category. Never duplicate an approved value here.
- macros_per_serving: a BALLPARK per-serving estimate (kcal, protein_g, carbs_g, fat_g), reasoned from the ingredients and servings. Approximate is expected. Use null only when there is not enough information at all.
- partial: true when the source was too thin to extract a confident recipe (missing ingredients or steps).

APPROVED VOCABULARY
cuisine: ${vocab.cuisine.join(", ")}
dish_type: ${vocab.dish_type.join(", ")}
dietary: ${vocab.dietary.join(", ")}`;
}

export async function enrich(ctx: EnrichContext): Promise<EnrichmentData> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const message = await client.messages.parse({
    model: "claude-sonnet-5",
    max_tokens: 8192,
    system: systemPrompt(ctx.approvedTags),
    messages: [{ role: "user", content: ctx.userContent }],
    output_config: { format: zodOutputFormat(Enrichment) },
  });
  if (!message.parsed_output) {
    throw new Error(`enrichment produced no parseable output (stop_reason: ${message.stop_reason})`);
  }
  return message.parsed_output;
}
