/** Settings stored in chrome.storage.sync (synced across the user's Chromes). */

export interface Settings {
  apiBase: string;
  apiKey: string;
}

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
