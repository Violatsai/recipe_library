import { Router } from "express";
import { z } from "zod";
import { runAgent } from "../agent/agent.js";

export const chatRouter = Router();

const Body = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1),
});

chatRouter.post("/chat", async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  try {
    const result = await runAgent(parsed.data.messages);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "agent failed" });
  }
});
