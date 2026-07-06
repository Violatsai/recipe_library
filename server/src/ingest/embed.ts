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

export async function embedText(text: string, kind: "document" | "query"): Promise<number[]> {
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
}

/** Postgres pgvector literal: [v1,v2,...] — bind as text, cast ::vector in SQL. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
