import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnqueueIngestionJobInput,
  IngestionJob,
  IngestionJobStore,
} from "../src/ingest/jobs.js";
import { createIngestionJobsRouter } from "../src/routes/ingestionJobs.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

function job(status: IngestionJob["status"] = "queued"): IngestionJob {
  const now = new Date("2026-07-31T12:00:00.000Z");
  return {
    id: JOB_ID,
    normalized_url: "https://example.com/recipe",
    source_url: "https://example.com/recipe?utm_source=test",
    source_type: "web",
    captured_title: "Example Recipe",
    status,
    attempt_count: 0,
    error_code: status === "failed" ? "UPSTREAM_ERROR" : null,
    error_message: status === "failed" ? "recipe extraction failed" : null,
    submitted_at: now,
    started_at: null,
    finished_at: null,
    updated_at: now,
    recipe_ids: [],
  };
}

describe("ingestion job routes", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let store: IngestionJobStore;
  let enqueue: ReturnType<typeof vi.fn<(input: EnqueueIngestionJobInput) => Promise<Awaited<ReturnType<IngestionJobStore["enqueue"]>>>>>;
  let listVisible: ReturnType<typeof vi.fn<IngestionJobStore["listVisible"]>>;
  let retry: ReturnType<typeof vi.fn<IngestionJobStore["retry"]>>;
  let dismiss: ReturnType<typeof vi.fn<IngestionJobStore["dismiss"]>>;
  let onAccepted: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    enqueue = vi.fn(async () => ({ job: job(), disposition: "created" as const }));
    listVisible = vi.fn(async () => [job()]);
    retry = vi.fn(async () => ({ kind: "ok" as const, job: job() }));
    dismiss = vi.fn(async () => ({ kind: "ok" as const }));
    onAccepted = vi.fn();
    store = { enqueue, listVisible, retry, dismiss };

    const app = express();
    app.use(express.json({ limit: "25mb" }));
    app.use("/api", createIngestionJobsRouter(store, () => "test-key", onAccepted));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    close = () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  afterEach(async () => {
    await close();
  });

  async function request(path: string, init?: RequestInit) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: init?.body
        ? { "content-type": "application/json", ...init.headers }
        : init?.headers,
    });
  }

  it("requires the extension API key before enqueueing", async () => {
    const response = await request("/api/ingestion-jobs", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/recipe" }),
    });
    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("validates enqueue bodies", async () => {
    const response = await request("/api/ingestion-jobs", {
      method: "POST",
      headers: { "x-api-key": "test-key" },
      body: JSON.stringify({ url: "file:///tmp/recipe.html" }),
    });
    expect(response.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("normalizes and durably accepts a captured web snapshot", async () => {
    const capturedHtml = "<html><body>secret captured recipe</body></html>";
    const response = await request("/api/ingestion-jobs", {
      method: "POST",
      headers: { "x-api-key": "test-key" },
      body: JSON.stringify({
        url: "https://example.com/recipe?utm_source=test",
        title: "  Example Recipe  ",
        html: capturedHtml,
      }),
    });
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({
      normalizedUrl: "https://example.com/recipe",
      sourceUrl: "https://example.com/recipe?utm_source=test",
      sourceType: "web",
      capturedTitle: "Example Recipe",
      sourceHtml: capturedHtml,
    });
    const body = await response.json() as Record<string, unknown>;
    expect(body.disposition).toBe("created");
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(body).not.toHaveProperty("source_html");
    expect(JSON.stringify(body)).not.toContain("secret captured recipe");
  });

  it("lists only the store's safe lifecycle representation", async () => {
    const response = await request("/api/ingestion-jobs");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({ id: JOB_ID, status: "queued", captured_title: "Example Recipe" }),
    ]);
  });

  it("retries failed jobs and rejects jobs in another state", async () => {
    retry.mockResolvedValueOnce({ kind: "invalid_status", status: "processing" });
    const conflict = await request(`/api/ingestion-jobs/${JOB_ID}/retry`, { method: "POST" });
    expect(conflict.status).toBe(409);

    retry.mockResolvedValueOnce({ kind: "ok", job: job("queued") });
    const accepted = await request(`/api/ingestion-jobs/${JOB_ID}/retry`, { method: "POST" });
    expect(accepted.status).toBe(202);
    expect((await accepted.json() as IngestionJob).status).toBe("queued");
    expect(onAccepted).toHaveBeenCalledOnce();
  });

  it("dismisses only failed jobs", async () => {
    dismiss.mockResolvedValueOnce({ kind: "invalid_status", status: "queued" });
    const conflict = await request(`/api/ingestion-jobs/${JOB_ID}`, { method: "DELETE" });
    expect(conflict.status).toBe(409);

    dismiss.mockResolvedValueOnce({ kind: "ok" });
    const removed = await request(`/api/ingestion-jobs/${JOB_ID}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
  });

  it("rejects malformed job ids without touching the store", async () => {
    const response = await request("/api/ingestion-jobs/not-a-uuid/retry", { method: "POST" });
    expect(response.status).toBe(400);
    expect(retry).not.toHaveBeenCalled();
  });
});
