/**
 * URL identity for dedup. Two bookmarks of the same recipe must normalize to
 * the same string so the ingestion upsert (M3) collapses them.
 *
 * Rules (per execution-plan M2):
 *  - lowercase host (URL() already does this), drop the fragment
 *  - YouTube watch/short/share forms canonicalize to
 *    https://www.youtube.com/watch?v=<ID>
 *  - otherwise: remove tracking params, sort the rest for a stable ordering
 */

const TRACKING_EXACT = new Set(["fbclid", "gclid", "igshid", "si", "feature"]);

function isYouTubeHost(host: string): boolean {
  return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
}

/** Return the 11-ish char video id for any YouTube video URL form, else null. */
export function youtubeVideoId(raw: string): string | null {
  try {
    return youtubeId(new URL(raw));
  } catch {
    return null;
  }
}

function youtubeId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return id ? id : null;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/);
    if (m) return m[1] ?? null;
  }
  return null;
}

export function normalizeUrl(raw: string): string {
  const u = new URL(raw); // throws on malformed input; the route validates first
  u.hash = "";

  const ytId = youtubeId(u);
  if (ytId) return `https://www.youtube.com/watch?v=${ytId}`;

  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (k.startsWith("utm_")) continue;
    if (TRACKING_EXACT.has(k)) continue;
    keep.push([k, v]);
  }
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = new URLSearchParams(keep).toString();

  return u.toString();
}

export function detectSource(raw: string): "web" | "youtube" {
  return isYouTubeHost(new URL(raw).hostname.toLowerCase()) ? "youtube" : "web";
}
