/**
 * TikTok caption extraction. A TikTok video page carries its caption only
 * inside the hydration-state JSON (<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">)
 * — there is no Recipe JSON-LD and, on the server-served page, no visible DOM
 * text, so readability extracts nothing. Recipe TikToks put the full recipe in
 * the caption, so that blob is the extraction source.
 *
 * The state JSON survives SPA navigation with the *original* page's data, so a
 * capture taken after browsing video-to-video in the same tab can carry a stale
 * caption. Guard: only trust the blob when its item id matches the id in the
 * URL being saved; otherwise fall back to the visible DOM.
 */

import { tiktokPostId } from "./normalizeUrl.js";

export interface TikTokCaption {
  author: string | null;
  caption: string;
}

const STATE_SCRIPT_RE =
  /<script[^>]*\bid="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/;

export function extractTikTokCaption(html: string, url: string): TikTokCaption | null {
  const postId = tiktokPostId(url);
  if (!postId) return null;

  const m = html.match(STATE_SCRIPT_RE);
  if (!m) return null;

  let item: Record<string, unknown>;
  try {
    const state = JSON.parse(m[1]!) as {
      __DEFAULT_SCOPE__?: {
        "webapp.video-detail"?: { itemInfo?: { itemStruct?: Record<string, unknown> } };
      };
    };
    const struct = state.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
    if (!struct) return null;
    item = struct;
  } catch {
    return null;
  }

  if (item.id !== postId) return null; // stale SPA state from a different post
  const caption = typeof item.desc === "string" ? item.desc.trim() : "";
  if (!caption) return null;

  const author = item.author as { uniqueId?: unknown } | undefined;
  return {
    author: typeof author?.uniqueId === "string" ? author.uniqueId : null,
    caption,
  };
}
