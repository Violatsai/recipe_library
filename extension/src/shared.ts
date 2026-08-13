/** Settings stored in chrome.storage.sync (synced across the user's Chromes). */

export interface Settings {
  apiBase: string;
  apiKey: string;
}

export interface QueueRecipeMessage {
  type: "queue-recipe";
  tabId: number;
  url: string;
  title?: string;
  /** Present for a social capture already reviewed in the popup. Ordinary
   *  page HTML is captured by the background worker; YouTube needs no HTML. */
  html?: string;
  /** Confirmed extraction from /ingest-preview. The server validates it and
   *  persists it with the job so confirmation does not run extraction twice. */
  previewedRecipes?: unknown;
}

export interface AcceptedIngestionJob {
  id: string;
  captured_title: string;
  status: "queued" | "processing";
  disposition: "created" | "existing" | "requeued";
}

export type QueueRecipeResponse =
  | { ok: true; job: AcceptedIngestionJob }
  | {
      ok: false;
      code: "NO_API_KEY" | "AUTH" | "CAPTURE_FAILED" | "PAGE_CHANGED" | "NETWORK" | "SERVER";
      message: string;
    };

export const DEFAULT_API_BASE = "http://localhost:3001";

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE, apiKey: "" });
  return { apiBase: (raw.apiBase as string) || DEFAULT_API_BASE, apiKey: (raw.apiKey as string) || "" };
}

export async function setSettings(s: Settings): Promise<void> {
  await chrome.storage.sync.set({ apiBase: s.apiBase.replace(/\/+$/, ""), apiKey: s.apiKey });
}

export function isYouTube(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

/** Facebook/Instagram/Threads collapse long captions behind a "see more"
 *  toggle that isn't in the DOM's text until clicked — these hosts need the
 *  expand step before HTML capture. */
export function isSocialCaptionSite(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const bases = ["facebook.com", "instagram.com", "threads.net", "threads.com"];
    return bases.some((b) => h === b || h.endsWith(`.${b}`));
  } catch {
    return false;
  }
}
