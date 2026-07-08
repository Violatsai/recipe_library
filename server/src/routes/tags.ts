import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db.js";

export const tagsRouter = Router();

tagsRouter.get("/tags", async (_req, res) => {
  const rows = (
    await query<{ id: string; category: string; value: string; status: string; usage_count: string }>(
      `SELECT t.id, t.category, t.value, t.status, count(rt.recipe_id) AS usage_count
         FROM tags t LEFT JOIN recipe_tags rt ON rt.tag_id = t.id
         GROUP BY t.id ORDER BY t.category, t.value`,
    )
  ).rows;
  res.json(rows.map((r) => ({ ...r, usage_count: Number(r.usage_count) })));
});

const Rename = z.object({ value: z.string().min(1) });

tagsRouter.patch("/tags/:id", async (req, res) => {
  const parsed = Rename.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "value (non-empty string) required" });
    return;
  }
  try {
    const r = await query<{ id: string }>(
      "UPDATE tags SET value = $1 WHERE id = $2 RETURNING id",
      [parsed.data.value, req.params.id],
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: "tag not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    // unique(category, value) violation → the name is taken; suggest merge
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "a tag with that value already exists in this category — use merge instead" });
      return;
    }
    throw err;
  }
});

tagsRouter.delete("/tags/:id", async (req, res) => {
  const r = await query("DELETE FROM tags WHERE id = $1", [req.params.id]);
  if (r.rowCount === 0) {
    res.status(404).json({ error: "tag not found" });
    return;
  }
  res.json({ ok: true });
});

const Merge = z.object({ into_tag_id: z.string().min(1) });

/** Merge tag :id into another tag of the same category: repoint recipe_tags, delete source. */
tagsRouter.post("/tags/:id/merge", async (req, res) => {
  const parsed = Merge.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "into_tag_id required" });
    return;
  }
  const sourceId = req.params.id;
  const targetId = parsed.data.into_tag_id;
  if (sourceId === targetId) {
    res.status(400).json({ error: "cannot merge a tag into itself" });
    return;
  }

  try {
    await withTransaction(async (client) => {
      const both = await client.query<{ id: string; category: string }>(
        "SELECT id, category FROM tags WHERE id = ANY($1)",
        [[sourceId, targetId]],
      );
      const source = both.rows.find((r) => r.id === sourceId);
      const target = both.rows.find((r) => r.id === targetId);
      if (!source || !target) throw new Error("404");
      if (source.category !== target.category) throw new Error("409-category");

      // repoint, skipping recipes already carrying the target tag
      await client.query(
        `INSERT INTO recipe_tags (recipe_id, tag_id)
           SELECT recipe_id, $1 FROM recipe_tags WHERE tag_id = $2
           ON CONFLICT DO NOTHING`,
        [targetId, sourceId],
      );
      await client.query("DELETE FROM recipe_tags WHERE tag_id = $1", [sourceId]);
      await client.query("DELETE FROM tags WHERE id = $1", [sourceId]);
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message === "404") {
      res.status(404).json({ error: "source or target tag not found" });
      return;
    }
    if (err instanceof Error && err.message === "409-category") {
      res.status(409).json({ error: "tags must be in the same category to merge" });
      return;
    }
    throw err;
  }
});
