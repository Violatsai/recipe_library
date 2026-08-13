import { describe, expect, it, vi } from "vitest";
import type { EnrichmentData } from "../src/ingest/enrich.js";
import type {
  ClaimedIngestionJob,
  IngestionWorkerStore,
} from "../src/ingest/jobs.js";
import { persistPreviewedWeb, type IngestResult } from "../src/ingest/pipeline.js";
import {
  IngestionWorker,
  processAvailableIngestionJobs,
  safeIngestionFailure,
  type IngestionWorkerDependencies,
  type WorkerLogger,
} from "../src/ingest/worker.js";

// The worker calls persistPreviewedWeb directly (it is not an injected
// dependency); stub just that export so the confirmed-preview branch is
// observable without a database.
vi.mock("../src/ingest/pipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ingest/pipeline.js")>()),
  persistPreviewedWeb: vi.fn(),
}));

function claimed(id: string): ClaimedIngestionJob {
  return {
    id,
    normalized_url: `https://example.com/${id}`,
    source_url: `https://example.com/${id}?utm_source=capture`,
    source_type: "web",
    captured_title: `Recipe ${id}`,
    source_html: `<html>${id}</html>`,
    previewed_recipes: null,
    attempt_count: 1,
  };
}

function result(id: string, recipeId = `recipe-${id}`): IngestResult {
  return {
    status: "saved",
    source: "web",
    normalizedUrl: `https://example.com/${id}`,
    recipeId,
    title: `Recipe ${id}`,
    partial: false,
  };
}

function logger(): WorkerLogger {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function fakeStore(queue: ClaimedIngestionJob[]): IngestionWorkerStore {
  return {
    recoverInterrupted: vi.fn(async () => 0),
    claimNext: vi.fn(async () => queue.shift() ?? null),
    markSucceeded: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
  };
}

describe("processAvailableIngestionJobs", () => {
  it("drains jobs sequentially and records every recipe produced", async () => {
    const store = fakeStore([claimed("one"), claimed("two")]);
    let active = 0;
    let maxActive = 0;
    const ingestRecipe = vi.fn(async ({ url }: { url: string }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      const id = url.includes("one") ? "one" : "two";
      return id === "one" ? [result(id), result(id, "recipe-one-b")] : [result(id)];
    });

    const count = await processAvailableIngestionJobs({ store, ingestRecipe, logger: logger() });

    expect(count).toBe(2);
    expect(maxActive).toBe(1);
    expect(store.markSucceeded).toHaveBeenNthCalledWith(1, "one", ["recipe-one", "recipe-one-b"]);
    expect(store.markSucceeded).toHaveBeenNthCalledWith(2, "two", ["recipe-two"]);
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it("marks extraction failures safely and continues to the next job", async () => {
    const store = fakeStore([claimed("bad"), claimed("good")]);
    const log = logger();
    const ingestRecipe = vi.fn(async ({ url }: { url: string }) => {
      if (url.includes("bad")) throw new Error("secret SDK response and stack details");
      return [result("good")];
    });

    const count = await processAvailableIngestionJobs({ store, ingestRecipe, logger: log });

    expect(count).toBe(2);
    expect(store.markFailed).toHaveBeenCalledWith(
      "bad",
      "EXTRACTION_FAILED",
      "Recipe extraction failed. Please retry this capture.",
    );
    expect(store.markSucceeded).toHaveBeenCalledWith("good", ["recipe-good"]);
    expect(JSON.stringify((store.markFailed as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("secret SDK");
  });

  it("persists a confirmed preview without re-running extraction", async () => {
    const confirmed: EnrichmentData = {
      title: "Confirmed Soup",
      servings: 2,
      total_time_min: 20,
      steps: ["Simmer."],
      ingredients: [{ name: "tomato", quantity: 2, unit: null, raw_text: "2 tomatoes" }],
      defining_ingredients: ["tomato"],
      tags: { cuisine: [], dish_type: [], dietary: [] },
      new_tags: [],
      macros_per_serving: null,
      partial: false,
      source_used: null,
    };
    const job = { ...claimed("previewed"), previewed_recipes: [confirmed] };
    const store = fakeStore([job]);
    const ingestRecipe = vi.fn(async () => [result("previewed")]);
    vi.mocked(persistPreviewedWeb).mockResolvedValueOnce([result("previewed")]);

    const count = await processAvailableIngestionJobs({ store, ingestRecipe, logger: logger() });

    expect(count).toBe(1);
    expect(ingestRecipe).not.toHaveBeenCalled();
    expect(persistPreviewedWeb).toHaveBeenCalledWith(
      { url: job.source_url, html: job.source_html },
      [confirmed],
    );
    expect(store.markSucceeded).toHaveBeenCalledWith("previewed", ["recipe-previewed"]);
  });

  it("passes the durable captured snapshot to the pipeline", async () => {
    const store = fakeStore([claimed("snapshot")]);
    const ingestRecipe = vi.fn(async () => [result("snapshot")]);
    await processAvailableIngestionJobs({ store, ingestRecipe, logger: logger() });
    expect(ingestRecipe).toHaveBeenCalledWith({
      url: "https://example.com/snapshot?utm_source=capture",
      html: "<html>snapshot</html>",
    });
  });
});

describe("IngestionWorker lifecycle", () => {
  it("recovers interrupted jobs when it starts", async () => {
    const store = fakeStore([]);
    (store.recoverInterrupted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);
    const log = logger();
    const deps: IngestionWorkerDependencies = {
      store,
      ingestRecipe: vi.fn(async () => []),
      logger: log,
    };
    const worker = new IngestionWorker(deps, 60_000);
    await worker.start();
    await worker.stop();
    expect(store.recoverInterrupted).toHaveBeenCalledOnce();
    expect(log.log).toHaveBeenCalledWith("requeued 2 interrupted ingestion jobs");
  });
});

describe("safeIngestionFailure", () => {
  it("classifies rate limits and never exposes the upstream message", () => {
    const failure = safeIngestionFailure({ statusCode: 429, message: "private provider payload" });
    expect(failure).toEqual({
      code: "RATE_LIMITED",
      message: "The extraction service is temporarily rate limited. Please retry shortly.",
    });
    expect(failure.message).not.toContain("private provider payload");
  });
});
