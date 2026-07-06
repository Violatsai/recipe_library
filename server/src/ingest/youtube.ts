import { YoutubeTranscript } from "youtube-transcript";
import { requireKey } from "../config.js";

/**
 * YouTube source handling (M4).
 *
 * - getVideoMeta: official Data API v3 (title/description/channel) — reliable.
 * - findRecipeLink: first non-social http(s) URL in the description; creators
 *   who link their recipe give us a clean web page to extract from instead of
 *   the transcript.
 * - getTranscript: unofficial scraper, the flakiest dependency in the project
 *   (see ARCHITECTURE.md → Implementation risks). Strictly best-effort: never
 *   throws, null on any failure. The pipeline proceeds without it and lets the
 *   enrichment pass mark the save partial when input is too thin.
 */

export interface VideoMeta {
  title: string;
  description: string;
  channel: string;
}

export async function getVideoMeta(videoId: string): Promise<VideoMeta> {
  const key = requireKey("youtubeApiKey");
  const url =
    `https://www.googleapis.com/youtube/v3/videos?part=snippet` +
    `&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(key)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`YouTube Data API returned HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as {
    items?: { snippet?: { title?: string; description?: string; channelTitle?: string } }[];
  };
  const snippet = body.items?.[0]?.snippet;
  if (!snippet) throw new Error(`YouTube video not found: ${videoId}`);
  return {
    title: snippet.title ?? "",
    description: snippet.description ?? "",
    channel: snippet.channelTitle ?? "",
  };
}

/** Hosts that are never a recipe page (socials, link hubs, shops, YouTube itself). */
const NON_RECIPE_HOSTS = [
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "fb.com",
  "twitter.com",
  "x.com",
  "linktr.ee",
  "patreon.com",
  "amzn.to",
  "amazon.com",
  "a.co", // amazon's short domain — seen in real cooking-video descriptions
  "discord.gg",
  "discord.com",
  "pinterest.com",
  "threads.net",
  "twitch.tv",
  "spotify.com",
  "apple.com",
  "bit.ly", // opaque shorteners: can't judge the target, skip rather than gamble
];

function isNonRecipeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return NON_RECIPE_HOSTS.some((bad) => h === bad || h.endsWith("." + bad));
}

/** First plausible recipe URL in a video description, or null. */
export function findRecipeLink(description: string): string | null {
  const matches = description.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?]+$/, ""); // strip trailing punctuation
    let u: URL;
    try {
      u = new URL(cleaned);
    } catch {
      continue;
    }
    if (!isNonRecipeHost(u.hostname)) return cleaned;
  }
  return null;
}

/** Best-effort transcript: joined text, or null on ANY failure. Never throws. */
export async function getTranscript(videoId: string): Promise<string | null> {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    const text = segments.map((s) => s.text).join(" ").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
