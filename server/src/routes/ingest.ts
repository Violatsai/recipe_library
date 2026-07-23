import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http.js";
import { config } from "../config.js";
import { NeedsHtmlError } from "../ingest/fetchPage.js";
import { ingest, ingestPhoto, previewIngest, NotARecipeError } from "../ingest/pipeline.js";

export const ingestRouter = Router();

const Body = z.object({
  url: z.string().url(),
  html: z.string().optional(),
});

const PhotoBody = z.object({
  imageBase64: z.string(),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
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
    // Bot-walled / unfetchable → tell the extension to resend page HTML.
    if (err instanceof NeedsHtmlError) {
      res.status(422).json({ error: "NEEDS_HTML" });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : "ingest failed" });
  }
});

// Same x-api-key gate as /ingest — extension-only. Lets the popup show what
// was actually captured (title, per recipe found) before committing to a
// save, for platforms where a stale/wrong page capture is a real risk.
ingestRouter.post("/ingest-preview", async (req, res) => {
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
    res.json(await previewIngest(parsed.data));
  } catch (err) {
    if (err instanceof NeedsHtmlError) {
      res.status(422).json({ error: "NEEDS_HTML" });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : "preview failed" });
  }
});

// No x-api-key gate: called from the local web UI (Library tab), not the
// extension — same trust level as the other web-facing routes in recipes.ts.
ingestRouter.post(
  "/ingest-photo",
  asyncHandler(async (req, res) => {
    const parsed = PhotoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      return;
    }
    try {
      res.json(await ingestPhoto(parsed.data));
    } catch (err) {
      if (err instanceof NotARecipeError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : "ingest failed" });
    }
  }),
);
