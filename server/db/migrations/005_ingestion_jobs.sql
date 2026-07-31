-- Durable lifecycle for fire-and-forget extension ingestion.
-- Captured input lives here until a job succeeds; incomplete records never
-- enter recipes/search/meal planning.

CREATE TABLE ingestion_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_url  text NOT NULL UNIQUE,
  source_url       text NOT NULL,
  source_type      text NOT NULL CHECK (source_type IN ('web', 'youtube')),
  captured_title   text NOT NULL,
  source_html      text,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  attempt_count    int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code       text,
  error_message    text,
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ingestion_jobs_status_submitted_idx
  ON ingestion_jobs (status, submitted_at);

CREATE TABLE ingestion_job_recipes (
  job_id     uuid NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  recipe_id  uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, recipe_id)
);

CREATE INDEX ingestion_job_recipes_recipe_id_idx
  ON ingestion_job_recipes (recipe_id);
