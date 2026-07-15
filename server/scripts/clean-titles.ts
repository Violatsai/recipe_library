import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";

/**
 * One-off: simplify existing recipe titles to plain dish names (same rule the
 * enrichment prompt now enforces for new ingests). Conservative — the model
 * returns a title per id and we only UPDATE rows whose title actually changed.
 * Embeddings are left as-is: the removed text is branding noise, so the
 * semantic drift is negligible at library scale.
 */

const Cleaned = z.object({
  titles: z.array(z.object({ id: z.string(), title: z.string().min(1) })),
});

async function main(): Promise<void> {
  const rows = (
    await pool.query<{ id: string; title: string }>("SELECT id, title FROM recipes ORDER BY created_at")
  ).rows;
  if (rows.length === 0) {
    console.log("no recipes");
    await pool.end();
    return;
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const message = await client.messages.parse({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: `You simplify recipe titles to the PLAIN DISH NAME. Rules:
- Strip channel/series/creator names, publication or video branding, episode markers, and decorations like "…做法" or a trailing "Recipe".
- Use the name an English-speaking cook would naturally call the dish — often the romanized native name itself ("Pad Thai", "Carbonara"). A Latin-script foreign title that has an English equivalent alongside it keeps just the natural English name (e.g. "Salsicce e Fagioli all'Uccelletto - Tuscan Bean and Sausage Stew" → "Tuscan Bean and Sausage Stew").
- If the title contains a NON-LATIN script dish name, keep the original dish name (decorations stripped) followed by the English name in parentheses: 茄香四季豆 (Tomato-Scented Green Beans). Chinese-first ordering even if the input had English first.
- Be conservative: only simplify clear redundancy or branding. If a title is already a plain dish name, return it UNCHANGED. Never reword genuinely descriptive titles.
Return one entry per input id.`,
    messages: [{ role: "user", content: rows.map((r) => `${r.id}\t${r.title}`).join("\n") }],
    output_config: { format: zodOutputFormat(Cleaned) },
  });
  const data = message.parsed_output;
  if (!data) throw new Error(`no parseable output (stop_reason: ${message.stop_reason})`);

  const current = new Map(rows.map((r) => [r.id, r.title]));
  const changes = data.titles.filter((t) => current.has(t.id) && current.get(t.id) !== t.title);

  if (changes.length === 0) {
    console.log("all titles already clean — nothing to do");
    await pool.end();
    return;
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const c of changes) {
      console.log(`  "${current.get(c.id)}"\n    -> "${c.title}"`);
      await db.query("UPDATE recipes SET title = $1, updated_at = now() WHERE id = $2", [c.title, c.id]);
    }
    await db.query("COMMIT");
    console.log(`updated ${changes.length}/${rows.length} titles`);
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
