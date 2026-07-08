import { Router } from "express";
import { asyncHandler } from "../http.js";
import { z } from "zod";
import { query } from "../db.js";

export const pantryRouter = Router();

pantryRouter.get("/pantry", asyncHandler(async (_req, res) => {
  const rows = (
    await query<{ id: string; name: string }>("SELECT id, name FROM pantry_staples ORDER BY name")
  ).rows;
  res.json(rows);
}));

const Add = z.object({ name: z.string().min(1) });

pantryRouter.post("/pantry", asyncHandler(async (req, res) => {
  const parsed = Add.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "name (non-empty string) required" });
    return;
  }
  const name = parsed.data.name.trim().toLowerCase();
  const r = await query<{ id: string; name: string }>(
    "INSERT INTO pantry_staples (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id, name",
    [name],
  );
  res.status(r.rowCount === 0 ? 200 : 201).json(r.rows[0] ?? { name, existed: true });
}));

pantryRouter.delete("/pantry/:id", asyncHandler(async (req, res) => {
  const r = await query("DELETE FROM pantry_staples WHERE id = $1", [req.params.id]);
  if (r.rowCount === 0) {
    res.status(404).json({ error: "staple not found" });
    return;
  }
  res.json({ ok: true });
}));
