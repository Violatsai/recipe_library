import { Router, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../http.js";
import {
  postgresIngestionJobStore,
  type IngestionJobStore,
  type JobMutationResult,
} from "../ingest/jobs.js";
import { detectSource, normalizeUrl } from "../ingest/normalizeUrl.js";
import { ingestionWorker } from "../ingest/worker.js";

const HttpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "url must use http or https");

const EnqueueBody = z.object({
  url: HttpUrl,
  title: z.string().max(500).optional(),
  html: z.string().optional(),
}).strict();

const JobId = z.string().uuid();

function sendMutationError(
  result: Exclude<JobMutationResult, { kind: "ok" }>,
  res: Response,
): void {
  if (result.kind === "not_found") {
    res.status(404).json({ error: "ingestion job not found" });
    return;
  }
  res.status(409).json({ error: `ingestion job is ${result.status}, not failed` });
}

export function createIngestionJobsRouter(
  store: IngestionJobStore = postgresIngestionJobStore,
  ingestApiKey: () => string | undefined = () => config.ingestApiKey,
  onAccepted: () => void = () => ingestionWorker.wake(),
) {
  const router = Router();

  router.post("/ingestion-jobs", asyncHandler(async (req, res) => {
    const key = req.header("x-api-key");
    const configuredKey = ingestApiKey();
    if (!configuredKey || key !== configuredKey) {
      res.status(401).json({ error: "invalid or missing x-api-key" });
      return;
    }

    const parsed = EnqueueBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      return;
    }

    const normalizedUrl = normalizeUrl(parsed.data.url);
    const fallbackTitle = new URL(parsed.data.url).hostname;
    const result = await store.enqueue({
      normalizedUrl,
      sourceUrl: parsed.data.url,
      sourceType: detectSource(parsed.data.url),
      capturedTitle: parsed.data.title?.trim() || fallbackTitle,
      sourceHtml: parsed.data.html,
    });
    onAccepted();
    res.status(202).json({ ...result.job, disposition: result.disposition });
  }));

  router.get("/ingestion-jobs", asyncHandler(async (_req, res) => {
    res.json(await store.listVisible());
  }));

  router.post("/ingestion-jobs/:id/retry", asyncHandler(async (req, res) => {
    const id = JobId.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid ingestion job id" });
      return;
    }
    const result = await store.retry(id.data);
    if (result.kind !== "ok") {
      sendMutationError(result, res);
      return;
    }
    onAccepted();
    res.status(202).json(result.job);
  }));

  router.delete("/ingestion-jobs/:id", asyncHandler(async (req, res) => {
    const id = JobId.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid ingestion job id" });
      return;
    }
    const result = await store.dismiss(id.data);
    if (result.kind !== "ok") {
      sendMutationError(result, res);
      return;
    }
    res.json({ ok: true });
  }));

  return router;
}

export const ingestionJobsRouter = createIngestionJobsRouter();
