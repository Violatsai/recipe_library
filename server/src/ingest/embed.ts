import { VoyageAIClient } from "voyageai";
import { requireKey } from "../config.js";

/**
 * Recipe embeddings via Voyage voyage-4-lite (1024 dims → recipes.embedding
 * vector(1024)). Isolated here so the provider is swappable.
 *
 * `kind` matters: Voyage optimizes document vs query embeddings separately.
 * Ingestion embeds recipes as 'document'; search embeds the user query as
 * 'query' (M6).
 */

let client: VoyageAIClient | null = null;
function getClient(): VoyageAIClient {
  if (!client) client = new VoyageAIClient({ apiKey: requireKey("voyageApiKey") });
  return client;
}

const RETRY_DELAYS_MS = [10_000, 20_000]; // Voyage free tier w/o payment method = 3 RPM

function isRateLimit(err: unknown): boolean {
  const status = (err as { statusCode?: number })?.statusCode;
  return status === 429;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function embedText(text: string, kind: "document" | "query"): Promise<number[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await getClient().embed({
        model: "voyage-4-lite",
        input: [text],
        inputType: kind,
      });
      const vector = res.data?.[0]?.embedding;
      if (!vector || vector.length === 0) {
        throw new Error("Voyage returned no embedding");
      }
      return vector;
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (!isRateLimit(err) || delay === undefined) throw err;
      console.warn(`voyage 429 — retrying in ${delay / 1000}s (attempt ${attempt + 1})`);
      await sleep(delay);
    }
  }
}

/** Postgres pgvector literal: [v1,v2,...] — bind as text, cast ::vector in SQL. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
