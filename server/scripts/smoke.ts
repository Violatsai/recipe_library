import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { normalizeUrl } from "../src/ingest/normalizeUrl.js";

/**
 * End-to-end smoke test against a RUNNING server (npm run dev:server first).
 * Enqueues the JSON-LD fixture with provided HTML (no external page fetch),
 * observes its durable lifecycle, asserts the worker persisted and linked the
 * recipe, then deletes both job and recipe rows.
 * Costs one Claude enrichment call + one Voyage embedding call.
 */

const SMOKE_URL = "https://smoke.test/miso-glazed-eggplant?utm_source=queue-smoke";
const NORMALIZED_SMOKE_URL = normalizeUrl(SMOKE_URL);
const TIMEOUT_MS = 120_000;
const base = `http://localhost:${config.port}`;

function fail(msg: string): never {
  throw new Error(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "../test/fixtures/recipe-jsonld.html"), "utf8");
  const apiKey = config.ingestApiKey;
  if (!apiKey) fail("INGEST_API_KEY is required for the queued-ingestion smoke test");

  let jobId: string | null = null;
  let recipeIds: string[] = [];

  try {
    // Remove leftovers from an interrupted earlier smoke run. This URL belongs
    // exclusively to the fixture and cannot collide with user recipes.
    await pool.query("DELETE FROM ingestion_jobs WHERE normalized_url = $1", [NORMALIZED_SMOKE_URL]);
    await pool.query(
      "DELETE FROM recipes WHERE source_url = $1 OR source_url LIKE $1 || '#%'",
      [NORMALIZED_SMOKE_URL],
    );

    const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
    if (!health || !(health as { ok: boolean }).ok) {
      fail(`server not healthy at ${base} — start it with: npm run dev:server`);
    }

    console.log("queueing fixture…");
    const resp = await fetch(`${base}/api/ingestion-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ url: SMOKE_URL, title: "Queue smoke: miso-glazed eggplant", html }),
    });
    const body = (await resp.json()) as { id?: string; status?: string; disposition?: string; error?: string };
    if (resp.status !== 202 || !body.id) {
      fail(`queue returned ${resp.status}: ${JSON.stringify(body)}`);
    }
    jobId = body.id;
    console.log(`accepted -> ${body.status} (${body.disposition}, ${jobId})`);

    let sawVisibleLifecycle = false;
    let htmlCleared = false;
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const visibleResp = await fetch(`${base}/api/ingestion-jobs`);
      if (!visibleResp.ok) fail(`lifecycle list returned HTTP ${visibleResp.status}`);
      const visible = await visibleResp.json() as { id: string; status: string }[];
      if (visible.some((job) => job.id === jobId)) sawVisibleLifecycle = true;

      const lifecycle = (
        await pool.query<{
          status: string;
          error_code: string | null;
          error_message: string | null;
          html_cleared: boolean;
          recipe_ids: string[] | null;
        }>(
          `SELECT ij.status, ij.error_code, ij.error_message,
                  ij.source_html IS NULL AS html_cleared,
                  array_agg(ijr.recipe_id ORDER BY ijr.recipe_id)
                    FILTER (WHERE ijr.recipe_id IS NOT NULL) AS recipe_ids
             FROM ingestion_jobs ij
             LEFT JOIN ingestion_job_recipes ijr ON ijr.job_id = ij.id
            WHERE ij.id = $1
            GROUP BY ij.id`,
          [jobId],
        )
      ).rows[0];
      if (!lifecycle) fail("accepted job disappeared before completion");
      if (lifecycle.status === "failed") {
        fail(`worker failed (${lifecycle.error_code}): ${lifecycle.error_message}`);
      }
      if (lifecycle.status === "succeeded") {
        recipeIds = lifecycle.recipe_ids ?? [];
        htmlCleared = lifecycle.html_cleared;
        break;
      }
      if (Date.now() >= deadline) fail(`job remained ${lifecycle.status} for ${TIMEOUT_MS / 1_000}s`);
      await sleep(500);
    }

    if (recipeIds.length === 0) fail("succeeded job has no recipe links");
    if (!htmlCleared) fail("succeeded job retained captured HTML");
    if (!sawVisibleLifecycle) {
      console.log("note: worker completed before the active lifecycle card could be observed");
    } else {
      console.log("observed queued/processing lifecycle through the Library API");
    }

    const checks = await pool.query<{ title: string; ingredients: string; tags: string; has_embedding: boolean }>(
      `SELECT r.title,
              (SELECT count(*) FROM ingredients i WHERE i.recipe_id = r.id)::text AS ingredients,
              (SELECT count(*) FROM recipe_tags rt WHERE rt.recipe_id = r.id)::text AS tags,
              r.embedding IS NOT NULL AS has_embedding
         FROM recipes r WHERE r.id = $1`,
      [recipeIds[0]],
    );
    const row = checks.rows[0];
    if (!row) fail("linked recipe row not found after worker success");
    if (!/eggplant/i.test(row.title)) fail(`unexpected title: ${row.title}`);
    if (Number(row.ingredients) < 3) fail(`too few ingredients: ${row.ingredients}`);
    if (Number(row.tags) < 1) fail("no tags attached");
    if (!row.has_embedding) fail("embedding missing");
    console.log(`checks ok: "${row.title}" — ${row.ingredients} ingredients, ${row.tags} tags, embedding present`);
  } finally {
    if (jobId && recipeIds.length === 0) {
      const linked = await pool.query<{ recipe_id: string }>(
        "SELECT recipe_id FROM ingestion_job_recipes WHERE job_id = $1",
        [jobId],
      );
      recipeIds = linked.rows.map((row) => row.recipe_id);
    }
    if (jobId) await pool.query("DELETE FROM ingestion_jobs WHERE id = $1", [jobId]);
    if (recipeIds.length > 0) await pool.query("DELETE FROM recipes WHERE id = ANY($1::uuid[])", [recipeIds]);
    console.log("cleaned up smoke job and recipe rows");
    await pool.end();
  }

  console.log("SMOKE PASS");
}

main().catch((err) => {
  console.error(`SMOKE FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
