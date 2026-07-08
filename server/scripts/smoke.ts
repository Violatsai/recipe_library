import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";

/**
 * End-to-end smoke test against a RUNNING server (npm run dev:server first).
 * Ingests the JSON-LD fixture with provided HTML (no external fetch), asserts
 * the recipe landed with ingredients/tags/embedding, then deletes the row.
 * Costs one Claude enrichment call + one Voyage embedding call.
 */

const SMOKE_URL = "https://smoke.test/miso-glazed-eggplant";
const base = `http://localhost:${config.port}`;

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "../test/fixtures/recipe-jsonld.html"), "utf8");

  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
  if (!health || !(health as { ok: boolean }).ok) {
    fail(`server not healthy at ${base} — start it with: npm run dev:server`);
  }

  console.log("ingesting fixture…");
  const resp = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.ingestApiKey ?? "" },
    body: JSON.stringify({ url: SMOKE_URL, html }),
  });
  const body = (await resp.json()) as { status?: string; recipeId?: string; error?: string };
  if (!resp.ok || !body.recipeId) fail(`ingest returned ${resp.status}: ${JSON.stringify(body)}`);
  console.log(`ingest -> ${body.status} (${body.recipeId})`);

  const checks = await pool.query<{ title: string; ingredients: string; tags: string; has_embedding: boolean }>(
    `SELECT r.title,
            (SELECT count(*) FROM ingredients i WHERE i.recipe_id = r.id)::text AS ingredients,
            (SELECT count(*) FROM recipe_tags rt WHERE rt.recipe_id = r.id)::text AS tags,
            r.embedding IS NOT NULL AS has_embedding
       FROM recipes r WHERE r.id = $1`,
    [body.recipeId],
  );
  const row = checks.rows[0];
  if (!row) fail("recipe row not found after ingest");
  if (!/eggplant/i.test(row.title)) fail(`unexpected title: ${row.title}`);
  if (Number(row.ingredients) < 3) fail(`too few ingredients: ${row.ingredients}`);
  if (Number(row.tags) < 1) fail(`no tags attached`);
  if (!row.has_embedding) fail("embedding missing");
  console.log(`checks ok: "${row.title}" — ${row.ingredients} ingredients, ${row.tags} tags, embedding present`);

  // cleanup — the smoke recipe must not linger in the user's library
  await pool.query("DELETE FROM recipes WHERE id = $1", [body.recipeId]);
  console.log("cleaned up smoke row");
  await pool.end();
  console.log("SMOKE PASS");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
