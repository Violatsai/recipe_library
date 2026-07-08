import pg from "pg";
import { config } from "./config.js";

// Parse Postgres numeric (OID 1700) as JS float rather than string, so macros
// and ingredient quantities arrive as numbers throughout the app. Recipe-scale
// values don't need arbitrary precision.
pg.types.setTypeParser(1700, (v: string | null) => (v === null ? null : Number.parseFloat(v)));

/**
 * Single shared connection pool. Import `query` for one-shot statements and
 * `withTransaction` for multi-statement atomic work (e.g. the ingestion upsert).
 */
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
