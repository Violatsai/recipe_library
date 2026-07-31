import type { PoolClient } from "pg";
import { query, withTransaction } from "../db.js";

export type IngestionJobStatus = "queued" | "processing" | "succeeded" | "failed";
export type IngestionJobSource = "web" | "youtube";

export interface IngestionJob {
  id: string;
  normalized_url: string;
  source_url: string;
  source_type: IngestionJobSource;
  captured_title: string;
  status: IngestionJobStatus;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  submitted_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
  recipe_ids: string[];
}

interface StoredIngestionJob extends Omit<IngestionJob, "recipe_ids"> {
  source_html: string | null;
}

export interface EnqueueIngestionJobInput {
  normalizedUrl: string;
  sourceUrl: string;
  sourceType: IngestionJobSource;
  capturedTitle: string;
  sourceHtml?: string;
}

export type EnqueueDisposition = "created" | "existing" | "requeued";

export interface EnqueueIngestionJobResult {
  job: IngestionJob;
  disposition: EnqueueDisposition;
}

export type JobMutationResult =
  | { kind: "ok"; job?: IngestionJob }
  | { kind: "not_found" }
  | { kind: "invalid_status"; status: IngestionJobStatus };

export interface IngestionJobStore {
  enqueue(input: EnqueueIngestionJobInput): Promise<EnqueueIngestionJobResult>;
  listVisible(): Promise<IngestionJob[]>;
  retry(id: string): Promise<JobMutationResult>;
  dismiss(id: string): Promise<JobMutationResult>;
}

export interface ClaimedIngestionJob {
  id: string;
  normalized_url: string;
  source_url: string;
  source_type: IngestionJobSource;
  captured_title: string;
  source_html: string | null;
  attempt_count: number;
}

export interface IngestionWorkerStore {
  recoverInterrupted(): Promise<number>;
  claimNext(): Promise<ClaimedIngestionJob | null>;
  markSucceeded(id: string, recipeIds: string[]): Promise<boolean>;
  markFailed(id: string, errorCode: string, errorMessage: string): Promise<boolean>;
}

const JOB_COLUMNS = `
  id, normalized_url, source_url, source_type, captured_title, source_html,
  status, attempt_count, error_code, error_message,
  submitted_at, started_at, finished_at, updated_at`;

function publicJob(row: StoredIngestionJob, recipeIds: string[] = []): IngestionJob {
  const { source_html: _sourceHtml, ...safe } = row;
  return { ...safe, recipe_ids: recipeIds };
}

async function replaceCompletedJob(
  client: PoolClient,
  id: string,
  input: EnqueueIngestionJobInput,
): Promise<StoredIngestionJob> {
  const row = (
    await client.query<StoredIngestionJob>(
      `UPDATE ingestion_jobs
          SET source_url = $2, source_type = $3, captured_title = $4, source_html = $5,
              status = 'queued', attempt_count = 0, error_code = NULL, error_message = NULL,
              submitted_at = now(), started_at = NULL, finished_at = NULL, updated_at = now()
        WHERE id = $1
        RETURNING ${JOB_COLUMNS}`,
      [id, input.sourceUrl, input.sourceType, input.capturedTitle, input.sourceHtml ?? null],
    )
  ).rows[0]!;
  await client.query("DELETE FROM ingestion_job_recipes WHERE job_id = $1", [id]);
  return row;
}

/**
 * Insert a durable queued job. INSERT ... ON CONFLICT serializes concurrent
 * first submissions for one normalized URL; the subsequent row lock decides
 * whether to reuse an active job or requeue a finished one.
 */
export async function enqueueIngestionJob(
  input: EnqueueIngestionJobInput,
): Promise<EnqueueIngestionJobResult> {
  return withTransaction(async (client) => {
    const inserted = (
      await client.query<StoredIngestionJob>(
        `INSERT INTO ingestion_jobs
           (normalized_url, source_url, source_type, captured_title, source_html)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (normalized_url) DO NOTHING
         RETURNING ${JOB_COLUMNS}`,
        [
          input.normalizedUrl,
          input.sourceUrl,
          input.sourceType,
          input.capturedTitle,
          input.sourceHtml ?? null,
        ],
      )
    ).rows[0];
    if (inserted) return { job: publicJob(inserted), disposition: "created" };

    const existing = (
      await client.query<StoredIngestionJob>(
        `SELECT ${JOB_COLUMNS} FROM ingestion_jobs
          WHERE normalized_url = $1 FOR UPDATE`,
        [input.normalizedUrl],
      )
    ).rows[0];
    if (!existing) {
      // The unique-conflict row cannot disappear before this transaction's
      // SELECT under normal operation. Surface a useful failure if it does.
      throw new Error("ingestion job disappeared during enqueue");
    }
    if (existing.status === "queued" || existing.status === "processing") {
      return { job: publicJob(existing), disposition: "existing" };
    }

    const requeued = await replaceCompletedJob(client, existing.id, input);
    return { job: publicJob(requeued), disposition: "requeued" };
  });
}

/** Visible Library lifecycle cards. Successful jobs are represented by their recipes. */
export async function listVisibleIngestionJobs(): Promise<IngestionJob[]> {
  const rows = (
    await query<StoredIngestionJob & { recipe_ids: string[] | null }>(
      `SELECT ${JOB_COLUMNS},
              array_agg(ijr.recipe_id ORDER BY ijr.recipe_id)
                FILTER (WHERE ijr.recipe_id IS NOT NULL) AS recipe_ids
         FROM ingestion_jobs ij
         LEFT JOIN ingestion_job_recipes ijr ON ijr.job_id = ij.id
        WHERE ij.status IN ('queued', 'processing', 'failed')
        GROUP BY ij.id
        ORDER BY CASE ij.status WHEN 'processing' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                 ij.submitted_at DESC`,
    )
  ).rows;
  return rows.map((row) => publicJob(row, row.recipe_ids ?? []));
}

export async function retryIngestionJob(id: string): Promise<JobMutationResult> {
  return withTransaction(async (client) => {
    const existing = (
      await client.query<StoredIngestionJob>(
        `SELECT ${JOB_COLUMNS} FROM ingestion_jobs WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!existing) return { kind: "not_found" };
    if (existing.status !== "failed") {
      return { kind: "invalid_status", status: existing.status };
    }

    const job = (
      await client.query<StoredIngestionJob>(
        `UPDATE ingestion_jobs
            SET status = 'queued', error_code = NULL, error_message = NULL,
                submitted_at = now(), started_at = NULL, finished_at = NULL, updated_at = now()
          WHERE id = $1
          RETURNING ${JOB_COLUMNS}`,
        [id],
      )
    ).rows[0]!;
    await client.query("DELETE FROM ingestion_job_recipes WHERE job_id = $1", [id]);
    return { kind: "ok", job: publicJob(job) };
  });
}

export async function dismissIngestionJob(id: string): Promise<JobMutationResult> {
  return withTransaction(async (client) => {
    const existing = (
      await client.query<Pick<StoredIngestionJob, "status">>(
        "SELECT status FROM ingestion_jobs WHERE id = $1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!existing) return { kind: "not_found" };
    if (existing.status !== "failed") {
      return { kind: "invalid_status", status: existing.status };
    }
    await client.query("DELETE FROM ingestion_jobs WHERE id = $1", [id]);
    return { kind: "ok" };
  });
}

/** Requeue work owned by a server process that stopped before completion. */
export async function recoverInterruptedIngestionJobs(): Promise<number> {
  const result = await query(
    `UPDATE ingestion_jobs
        SET status = 'queued', started_at = NULL, finished_at = NULL, updated_at = now()
      WHERE status = 'processing'`,
  );
  return result.rowCount ?? 0;
}

/** Atomically claim the oldest queued job. SKIP LOCKED keeps the claim safe even
 *  if a second server process is accidentally started. */
export async function claimNextIngestionJob(): Promise<ClaimedIngestionJob | null> {
  return withTransaction(async (client) => {
    const row = (
      await client.query<ClaimedIngestionJob>(
        `WITH next_job AS (
           SELECT id FROM ingestion_jobs
            WHERE status = 'queued'
            ORDER BY submitted_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE ingestion_jobs ij
            SET status = 'processing', attempt_count = ij.attempt_count + 1,
                started_at = now(), finished_at = NULL,
                error_code = NULL, error_message = NULL, updated_at = now()
           FROM next_job
          WHERE ij.id = next_job.id
         RETURNING ij.id, ij.normalized_url, ij.source_url, ij.source_type,
                   ij.captured_title, ij.source_html, ij.attempt_count`,
      )
    ).rows[0];
    return row ?? null;
  });
}

/** Complete lifecycle state only after the recipe batch has committed. */
export async function markIngestionJobSucceeded(
  id: string,
  recipeIds: string[],
): Promise<boolean> {
  return withTransaction(async (client) => {
    const locked = (
      await client.query<{ status: IngestionJobStatus }>(
        "SELECT status FROM ingestion_jobs WHERE id = $1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!locked || locked.status !== "processing") return false;

    await client.query("DELETE FROM ingestion_job_recipes WHERE job_id = $1", [id]);
    for (const recipeId of new Set(recipeIds)) {
      await client.query(
        `INSERT INTO ingestion_job_recipes (job_id, recipe_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, recipeId],
      );
    }
    await client.query(
      `UPDATE ingestion_jobs
          SET status = 'succeeded', source_html = NULL,
              error_code = NULL, error_message = NULL,
              finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [id],
    );
    return true;
  });
}

/** Record a user-safe failure while preserving captured input for Retry. */
export async function markIngestionJobFailed(
  id: string,
  errorCode: string,
  errorMessage: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE ingestion_jobs
        SET status = 'failed', error_code = $2, error_message = $3,
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'processing'`,
    [id, errorCode, errorMessage],
  );
  return result.rowCount === 1;
}

export const postgresIngestionJobStore: IngestionJobStore = {
  enqueue: enqueueIngestionJob,
  listVisible: listVisibleIngestionJobs,
  retry: retryIngestionJob,
  dismiss: dismissIngestionJob,
};

export const postgresIngestionWorkerStore: IngestionWorkerStore = {
  recoverInterrupted: recoverInterruptedIngestionJobs,
  claimNext: claimNextIngestionJob,
  markSucceeded: markIngestionJobSucceeded,
  markFailed: markIngestionJobFailed,
};
