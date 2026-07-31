import { NeedsHtmlError } from "./fetchPage.js";
import {
  postgresIngestionWorkerStore,
  type IngestionWorkerStore,
} from "./jobs.js";
import {
  ingest,
  NoRecipesExtractedError,
  type IngestInput,
  type IngestResult,
} from "./pipeline.js";

export interface WorkerLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface IngestionWorkerDependencies {
  store: IngestionWorkerStore;
  ingestRecipe: (input: IngestInput) => Promise<IngestResult[]>;
  logger: WorkerLogger;
}

export interface SafeIngestionFailure {
  code: string;
  message: string;
}

/** Convert arbitrary SDK/network/parser failures into text safe for the Library UI. */
export function safeIngestionFailure(error: unknown): SafeIngestionFailure {
  if (error instanceof NoRecipesExtractedError) {
    return {
      code: "NOT_A_RECIPE",
      message: "No recipe could be extracted from this capture.",
    };
  }
  if (error instanceof NeedsHtmlError) {
    return {
      code: "NEEDS_HTML",
      message: "The recipe page could not be read. Capture the page again and retry.",
    };
  }
  const status = (error as { status?: number; statusCode?: number } | null)?.status
    ?? (error as { statusCode?: number } | null)?.statusCode;
  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      message: "The extraction service is temporarily rate limited. Please retry shortly.",
    };
  }
  if (typeof status === "number" && status >= 500) {
    return {
      code: "UPSTREAM_UNAVAILABLE",
      message: "The extraction service is temporarily unavailable. Please retry.",
    };
  }
  return {
    code: "EXTRACTION_FAILED",
    message: "Recipe extraction failed. Please retry this capture.",
  };
}

/** Drain every currently queued job, one at a time. A failed extraction is
 *  persisted and does not prevent later jobs from running. */
export async function processAvailableIngestionJobs(
  deps: IngestionWorkerDependencies,
): Promise<number> {
  let processed = 0;
  for (;;) {
    const job = await deps.store.claimNext();
    if (!job) return processed;
    processed++;

    let results: IngestResult[];
    try {
      results = await deps.ingestRecipe({
        url: job.source_url,
        html: job.source_html ?? undefined,
      });
    } catch (error) {
      const safe = safeIngestionFailure(error);
      deps.logger.error(`ingestion job ${job.id} failed`, error);
      const marked = await deps.store.markFailed(job.id, safe.code, safe.message);
      if (!marked) deps.logger.warn(`ingestion job ${job.id} was no longer processing when failure was recorded`);
      continue;
    }

    const marked = await deps.store.markSucceeded(
      job.id,
      results.map((result) => result.recipeId),
    );
    if (marked) {
      deps.logger.log(`ingestion job ${job.id} succeeded (${results.length} recipe${results.length === 1 ? "" : "s"})`);
    } else {
      deps.logger.warn(`ingestion job ${job.id} was no longer processing when success was recorded`);
    }
  }
}

const defaultLogger: WorkerLogger = {
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
};

/** Single polling loop around the durable Postgres queue. Timers are unref'd
 *  so an idle worker does not keep scripts/tests alive. */
export class IngestionWorker {
  private readonly deps: IngestionWorkerDependencies;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<number> | null = null;
  private started = false;
  private stopping = false;

  constructor(
    deps: IngestionWorkerDependencies = {
      store: postgresIngestionWorkerStore,
      ingestRecipe: ingest,
      logger: defaultLogger,
    },
    pollIntervalMs = 1_000,
  ) {
    this.deps = deps;
    this.pollIntervalMs = pollIntervalMs;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    try {
      const recovered = await this.deps.store.recoverInterrupted();
      if (recovered > 0) {
        this.deps.logger.log(`requeued ${recovered} interrupted ingestion job${recovered === 1 ? "" : "s"}`);
      }
      this.schedule(0);
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  /** Prompt the worker after enqueue; polling remains the correctness fallback. */
  wake(): void {
    if (!this.started || this.stopping || this.drainPromise) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.drainPromise;
    this.started = false;
  }

  private schedule(delay: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delay);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    if (this.stopping || this.drainPromise) return;
    this.drainPromise = processAvailableIngestionJobs(this.deps);
    try {
      await this.drainPromise;
    } catch (error) {
      this.deps.logger.error("ingestion worker poll failed", error);
    } finally {
      this.drainPromise = null;
      this.schedule(this.pollIntervalMs);
    }
  }
}

export const ingestionWorker = new IngestionWorker();
