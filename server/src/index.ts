import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { pool, query } from "./db.js";
import { ingestionWorker } from "./ingest/worker.js";
import { chatRouter } from "./routes/chat.js";
import { groceryRouter } from "./routes/grocery.js";
import { ingestRouter } from "./routes/ingest.js";
import { ingestionJobsRouter } from "./routes/ingestionJobs.js";
import { pantryRouter } from "./routes/pantry.js";
import { recipesRouter } from "./routes/recipes.js";
import { tagsRouter } from "./routes/tags.js";

const UPLOADS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../uploads");

const app = express();
// 25mb: photo uploads (base64-encoded phone photos) run larger than the
// original 5mb text-ingestion limit.
app.use(express.json({ limit: "25mb" }));
app.use("/uploads", express.static(UPLOADS_DIR));

// request log: method path -> status (ms)
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use("/api", ingestRouter);
app.use("/api", ingestionJobsRouter);
app.use("/api", chatRouter);
app.use("/api", recipesRouter);
app.use("/api", tagsRouter);
app.use("/api", pantryRouter);
app.use("/api", groceryRouter);

// unknown /api paths and uncaught route errors both answer with { error }
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found" });
});
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("unhandled route error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  },
);

app.get("/health", async (_req, res) => {
  let db = false;
  try {
    await query("SELECT 1");
    db = true;
  } catch {
    db = false;
  }
  res.status(db ? 200 : 503).json({ ok: db, db });
});

const server = app.listen(config.port, () => {
  console.log(`server listening on http://localhost:${config.port}`);
  void ingestionWorker.start().catch((error) => {
    console.error("ingestion worker failed to start:", error);
  });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ingestionWorker.stop();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error("shutdown failed:", error);
      process.exitCode = 1;
    });
  });
}
