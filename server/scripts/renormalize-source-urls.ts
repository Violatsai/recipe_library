import { normalizeUrl } from "../src/ingest/normalizeUrl.js";
import { pool } from "../src/db.js";

/**
 * One-off: re-run normalizeUrl() over every stored recipes.source_url.
 * Needed after normalization rules change (e.g. the trailing-slash strip) —
 * existing rows keep whatever they were saved with; only NEW ingests get the
 * updated normalization unless we backfill. Detects would-be collisions
 * (two rows normalizing to the same URL) and skips those with a warning
 * rather than violating the UNIQUE constraint.
 */

async function main(): Promise<void> {
  const rows = (
    await pool.query<{ id: string; title: string; source_url: string }>(
      "SELECT id, title, source_url FROM recipes ORDER BY created_at",
    )
  ).rows;

  const byNewUrl = new Map<string, { id: string; title: string; source_url: string }[]>();
  for (const r of rows) {
    const next = normalizeUrl(r.source_url);
    if (next === r.source_url) continue;
    const list = byNewUrl.get(next) ?? [];
    list.push(r);
    byNewUrl.set(next, list);
  }

  if (byNewUrl.size === 0) {
    console.log("all source_urls already normalized — nothing to do");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let updated = 0;
    for (const [next, group] of byNewUrl) {
      if (group.length > 1) {
        console.log(`SKIPPED (collision) — these would all normalize to ${next}:`);
        for (const r of group) console.log(`    "${r.title}" (${r.source_url})`);
        continue;
      }
      const r = group[0]!;
      // also guard against colliding with an UNCHANGED existing row
      const clash = rows.find((o) => o.id !== r.id && o.source_url === next);
      if (clash) {
        console.log(`SKIPPED (would collide with existing row "${clash.title}") — "${r.title}" (${r.source_url})`);
        continue;
      }
      console.log(`  "${r.title}"\n    ${r.source_url}\n    -> ${next}`);
      await client.query("UPDATE recipes SET source_url = $1, updated_at = now() WHERE id = $2", [next, r.id]);
      updated++;
    }
    await client.query("COMMIT");
    console.log(`\nupdated ${updated} source_url(s)`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
