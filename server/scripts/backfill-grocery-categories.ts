import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { GROCERY_CATEGORIES } from "../src/agent/tools.js";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";

/**
 * One-off backfill: grocery items saved before migration 003 have no store
 * section (category IS NULL) and render under "other". Categorize them with
 * one Claude call and update in place. Idempotent — re-running with nothing
 * to backfill is a no-op.
 */

const Assignments = z.object({
  assignments: z.array(
    z.object({
      id: z.string(),
      category: z.enum(GROCERY_CATEGORIES),
    }),
  ),
});

async function main(): Promise<void> {
  const items = (
    await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM grocery_items WHERE category IS NULL ORDER BY name",
    )
  ).rows;
  if (items.length === 0) {
    console.log("nothing to backfill — all grocery items already have a category");
    await pool.end();
    return;
  }
  console.log(`categorizing ${items.length} uncategorized items…`);

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const message = await client.messages.parse({
    model: "claude-sonnet-5",
    max_tokens: 8192,
    system:
      `Assign each grocery item to exactly one store section from: ${GROCERY_CATEGORIES.join(", ")}. ` +
      `Return one assignment per input id. Judge by what the item IS (e.g. "butter beans" ` +
      `are beans → grains & pantry, not dairy; fresh herbs → produce; canned goods → grains & pantry).`,
    messages: [
      {
        role: "user",
        content: items.map((i) => `${i.id}\t${i.name}`).join("\n"),
      },
    ],
    output_config: { format: zodOutputFormat(Assignments) },
  });
  const data = message.parsed_output;
  if (!data) throw new Error(`no parseable output (stop_reason: ${message.stop_reason})`);

  const byId = new Map(items.map((i) => [i.id, i.name]));
  const client2 = await pool.connect();
  try {
    await client2.query("BEGIN");
    let updated = 0;
    for (const a of data.assignments) {
      if (!byId.has(a.id)) continue; // ignore any hallucinated ids
      await client2.query("UPDATE grocery_items SET category = $1 WHERE id = $2", [a.category, a.id]);
      console.log(`  ${byId.get(a.id)} -> ${a.category}`);
      updated++;
    }
    await client2.query("COMMIT");
    console.log(`updated ${updated}/${items.length}`);
    const remaining = (
      await client2.query<{ n: string }>("SELECT count(*)::text AS n FROM grocery_items WHERE category IS NULL")
    ).rows[0];
    console.log(`still uncategorized: ${remaining?.n ?? "?"}`);
  } catch (err) {
    await client2.query("ROLLBACK");
    throw err;
  } finally {
    client2.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
