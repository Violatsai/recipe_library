import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { buildTools, type ToolEvent } from "./tools.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentResult {
  reply: string;
  toolEvents: ToolEvent[];
}

/**
 * Run one agent turn over the full client-held history. The SDK tool runner
 * drives the search/plan/grocery loop; each tool call is captured in
 * `toolEvents` for the UI to render as cards.
 */
export async function runAgent(messages: ChatMessage[]): Promise<AgentResult> {
  const events: ToolEvent[] = [];
  const tools = buildTools(events);
  const system = await buildSystemPrompt();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const final = await client.beta.messages.toolRunner({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system,
    tools,
    messages,
  });

  let reply = "";
  for (const block of final.content) {
    if (block.type === "text") reply += block.text;
  }
  return { reply: reply.trim(), toolEvents: events };
}
