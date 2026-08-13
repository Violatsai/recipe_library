-- A confirmed social preview has already completed the expensive extraction.
-- Keep it with the durable job so confirmation does not call the model twice.
ALTER TABLE ingestion_jobs
  ADD COLUMN previewed_recipes jsonb;
