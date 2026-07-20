import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { NeedsHtmlError } from "../src/ingest/fetchPage.js";
import { ingest } from "../src/ingest/pipeline.js";
import { pool } from "../src/db.js";

/**
 * One-off: bulk-ingest every bookmark in a folder, from a Chrome bookmarks
 * export. Calls the ingestion pipeline directly (no server/API key needed) —
 * same code path as a normal save, just without a browser tab to fall back to
 * for bot-walled pages (those are reported, not silently dropped, so you can
 * finish them one-by-one via the extension).
 *
 * Export the folder from Chrome first:
 *   chrome://bookmarks -> ⋮ menu -> Export bookmarks -> save the .html file
 *
 * Usage:
 *   npx tsx server/scripts/bulk-import-bookmarks.ts <bookmarks.html> "<Folder Name>" [--dry-run] [--limit N]
 *
 *   --dry-run   list the URLs that would be imported, without ingesting
 *   --limit N   only process N URLs (after --skip), for a test run
 *   --skip N    skip the first N URLs — resume a batch without re-processing
 *               (and re-spending API calls on) items already done
 */

const DELAY_MS = 1500; // be polite to source sites between fetches

interface Bookmark {
  url: string;
  title: string;
}

/** Chrome's export is standard "Netscape Bookmark" HTML: nested <H3> folder
 *  headers followed by a sibling <DL> containing that folder's <A> entries
 *  (and nested subfolders). Folder match is case-insensitive, exact name. */
function findFolderBookmarks(html: string, folderName: string): { found: Bookmark[]; allFolders: string[] } {
  const { document } = new JSDOM(html).window;
  const headers = [...document.querySelectorAll("h3")];
  const allFolders = headers.map((h) => h.textContent?.trim() ?? "").filter(Boolean);

  const target = headers.find((h) => h.textContent?.trim().toLowerCase() === folderName.trim().toLowerCase());
  if (!target) return { found: [], allFolders };

  let dl = target.nextElementSibling;
  while (dl && dl.tagName !== "DL") dl = dl.nextElementSibling;
  if (!dl) return { found: [], allFolders };

  const anchors = [...dl.querySelectorAll("a")];
  const found = anchors
    .map((a) => ({ url: a.getAttribute("href") ?? "", title: a.textContent?.trim() ?? "" }))
    .filter((b) => /^https?:\/\//.test(b.url));
  return { found, allFolders };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : undefined;
  const skipIdx = args.indexOf("--skip");
  const skip = skipIdx !== -1 ? Number(args[skipIdx + 1]) : 0;
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && args[i - 1] !== "--limit" && args[i - 1] !== "--skip",
  );
  const [filePath, folderName] = positional;

  if (!filePath || !folderName) {
    console.error(
      'Usage: npx tsx server/scripts/bulk-import-bookmarks.ts <bookmarks.html> "<Folder Name>" [--dry-run] [--limit N]',
    );
    process.exit(1);
  }

  const html = readFileSync(filePath, "utf8");
  const { found, allFolders } = findFolderBookmarks(html, folderName);

  if (found.length === 0) {
    console.error(`No folder named "${folderName}" with bookmarks was found.`);
    console.error(`Folders in this export: ${[...new Set(allFolders)].join(", ")}`);
    process.exit(1);
  }

  const afterSkip = skip ? found.slice(skip) : found;
  const items = limit ? afterSkip.slice(0, limit) : afterSkip;
  const rangeNote = skip || limit ? ` (items ${skip + 1}–${skip + items.length} of ${found.length})` : "";
  console.log(`Found ${found.length} bookmark(s) in "${folderName}"${rangeNote}.`);

  if (dryRun) {
    for (const b of items) console.log(`  ${b.url}  ${b.title ? `(${b.title})` : ""}`);
    console.log("\nDry run — nothing was ingested.");
    return;
  }

  let saved = 0;
  let updated = 0;
  const needsManual: string[] = [];
  const failed: { url: string; error: string }[] = [];

  for (let i = 0; i < items.length; i++) {
    const b = items[i]!;
    process.stdout.write(`[${i + 1}/${items.length}] ${b.url} ... `);
    try {
      const result = await ingest({ url: b.url });
      if (result.status === "saved") saved++;
      else updated++;
      console.log(`${result.status} — ${result.title}${result.partial ? " (partial)" : ""}`);
    } catch (err) {
      if (err instanceof NeedsHtmlError) {
        needsManual.push(b.url);
        console.log("SKIPPED — page unreachable/bot-walled server-side; save it manually via the extension");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push({ url: b.url, error: msg });
        console.log(`FAILED — ${msg}`);
      }
    }
    if (i < items.length - 1) await sleep(DELAY_MS);
  }

  console.log("\n=== Summary ===");
  console.log(`saved: ${saved}  updated: ${updated}  needs manual save: ${needsManual.length}  failed: ${failed.length}`);
  if (needsManual.length > 0) {
    console.log("\nOpen these and click the extension to save (bot-walled or otherwise unfetchable server-side):");
    for (const u of needsManual) console.log(`  ${u}`);
  }
  if (failed.length > 0) {
    console.log("\nFailed (not a bot-wall — check the error):");
    for (const f of failed) console.log(`  ${f.url}\n    ${f.error}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
