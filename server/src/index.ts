import express from "express";
import { config } from "./config.js";
import { query } from "./db.js";
import { chatRouter } from "./routes/chat.js";
import { ingestRouter } from "./routes/ingest.js";

const app = express();
app.use(express.json({ limit: "5mb" }));

app.use("/api", ingestRouter);
app.use("/api", chatRouter);

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
