import { detectSource, normalizeUrl } from "./normalizeUrl.js";

/**
 * Ingestion orchestrator. M2 stub: resolves URL identity + source only.
 * M3/M4 replace the body with fetch → enrich → embed → upsert.
 */

export interface IngestInput {
  url: string;
  html?: string;
}

export interface IngestResult {
  status: "detected" | "saved" | "updated";
  source: "web" | "youtube";
  normalizedUrl: string;
}

export async function ingest(input: IngestInput): Promise<IngestResult> {
  const normalizedUrl = normalizeUrl(input.url);
  const source = detectSource(input.url);
  return { status: "detected", source, normalizedUrl };
}
