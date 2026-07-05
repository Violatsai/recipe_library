import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { ingest } from "../ingest/pipeline.js";

export const ingestRouter = Router();

const Body = z.object({
  url: z.string().url(),
  html: z.string().optional(),
});

ingestRouter.post("/ingest", async (req, res) => {
  // Fail closed: if no key is configured, reject everything.
  const key = req.header("x-api-key");
  if (!config.ingestApiKey || key !== config.ingestApiKey) {
    res.status(401).json({ error: "invalid or missing x-api-key" });
    return;
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  try {
    res.json(await ingest(parsed.data));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "ingest failed" });
  }
});
