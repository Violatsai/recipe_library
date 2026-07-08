import express from "express";
import { config } from "./config.js";
import { query } from "./db.js";
import { chatRouter } from "./routes/chat.js";
import { groceryRouter } from "./routes/grocery.js";
import { ingestRouter } from "./routes/ingest.js";
import { pantryRouter } from "./routes/pantry.js";
import { recipesRouter } from "./routes/recipes.js";
import { tagsRouter } from "./routes/tags.js";

const app = express();
app.use(express.json({ limit: "5mb" }));

// request log: method path -> status (ms)
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use("/api", ingestRouter);
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

app.listen(config.port, () => {
  console.log(`server listening on http://localhost:${config.port}`);
});
