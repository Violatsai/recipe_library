import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the single repo-root .env explicitly, so env vars resolve no matter the
// process cwd (npm runs this workspace with cwd=server/). We run via tsx (no
// dist build), so this file lives at server/src/config.ts → ../../.env = root.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env") });

/**
 * Central env access. Fails fast with a clear message when a required var is
 * missing, so misconfiguration surfaces at boot rather than mid-request.
 *
 * Keys that later milestones need (ANTHROPIC_API_KEY, VOYAGE_API_KEY,
 * YOUTUBE_API_KEY, INGEST_API_KEY) are declared here but only marked required
 * as those milestones wire them in — see `required` below.
 */

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export const config = {
  databaseUrl: req("DATABASE_URL"),
  port: Number(process.env.PORT ?? 3001),

  // Required from the milestone that first uses them; optional at M0 so the
  // server can boot and pass /health before every key is present.
  anthropicApiKey: opt("ANTHROPIC_API_KEY"),
  voyageApiKey: opt("VOYAGE_API_KEY"),
  youtubeApiKey: opt("YOUTUBE_API_KEY"),
  ingestApiKey: opt("INGEST_API_KEY"),
} as const;

/**
 * Assert a key is present at the point an operation needs it, with a clear
 * error. Lets the server boot for /health without every key, while failing
 * loudly the moment ingestion/agent code actually requires one.
 */
export function requireKey(
  name: "anthropicApiKey" | "voyageApiKey" | "youtubeApiKey" | "ingestApiKey",
): string {
  const v = config[name];
  if (!v) {
    throw new Error(`Missing required environment variable for this operation: ${name}`);
  }
  return v;
}
