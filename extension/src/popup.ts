import { getSettings, isSocialCaptionSite, isYouTube } from "./shared.js";

/**
 * Popup save flow:
 *   YouTube tab      → POST { url }                (server handles meta/link/transcript)
 *   any other tab    → POST { url, html }          (client-side capture — the page is
 *                                                   already rendered in the user's browser,
 *                                                   which also preempts NEEDS_HTML bot walls)
 *
 * Known limitation (accepted in the plan): the fetch runs in the popup, so the
 * popup must stay open until the response arrives (~10–30 s while the server
 * enriches). The hint text tells the user.
 */

const saveBtn = document.getElementById("save") as HTMLButtonElement;
const titleEl = document.getElementById("page-title")!;
const statusEl = document.getElementById("status")!;
const hintEl = document.getElementById("hint")!;

function setStatus(kind: "ok" | "err" | "busy" | "", text: string): void {
  statusEl.className = kind;
  statusEl.textContent = text;
}

interface IngestResult {
  status: "saved" | "updated";
  title: string;
  partial: boolean;
}

interface IngestError {
  error?: string;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Runs in the page's own context via chrome.scripting.executeScript, so it
 *  must be fully self-contained (no closures over outer-scope variables).
 *
 *  Three problems this solves, all confirmed live against real posts:
 *   1. These apps hydrate the actual post content asynchronously — the DOM
 *      right after navigation is just nav chrome (sidebar, "Messages"
 *      widget) with no post text at all. Capturing HTML at that point
 *      produces an empty extraction.
 *   2. Browsing from one post straight to another in the SAME tab (e.g.
 *      pasting a new URL over an already-loaded post) can leave the
 *      PREVIOUS post's content sitting in the DOM while the new one is
 *      still loading — long enough to look ready, and even <link
 *      rel="canonical">/<meta property="og:url"> can already show the new
 *      URL (these update on route change, ahead of the async data fetch
 *      that actually replaces the body). A one-shot check for "enough text"
 *      or "meta matches the URL" can pass while still looking at the
 *      previous post — confirmed live: this DOM appears to be a virtualized
 *      feed, other unrelated posts' links are present alongside the
 *      current one even once things "look" settled.
 *   3. Facebook (and sometimes Instagram) collapse long captions behind a
 *      "see more"/"查看更多" toggle whose text isn't in the DOM until
 *      clicked.
 *
 *  Fix for #1/#2: don't trust a single snapshot. Require the primary
 *  container's text to (a) be long enough, (b) have its meta tags agree
 *  with the current URL when present, AND (c) stay UNCHANGED across
 *  repeated checks for a stability window — a swap from stale to real
 *  content shows up as a change and resets the clock.
 */
async function expandCaptionsInPage(): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const primaryContainer = (): Element =>
    document.querySelector("article") ?? document.querySelector("main") ?? document.body;

  // The last non-empty path segment is the post/reel id on every URL form
  // these hosts use (/p/<id>, /reel/<id>, /reels/<id>, /share/r/<id>).
  const currentPostId = (): string | null => {
    const segs = location.pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] ?? null;
  };

  const metaMatchesCurrentUrl = (): boolean => {
    const id = currentPostId();
    if (!id) return true; // nothing to cross-check — don't block on this signal
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? "";
    const ogUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content ?? "";
    if (!canonical && !ogUrl) return true; // no meta tags present — don't block
    return canonical.includes(id) || ogUrl.includes(id);
  };

  const isReady = (): boolean =>
    (primaryContainer().textContent ?? "").trim().length >= 400 && metaMatchesCurrentUrl();

  const STABLE_MS = 900; // must hold steady this long before we trust it
  const start = Date.now();
  let prevSnapshot: string | null = null;
  let stableSince: number | null = null;
  while (Date.now() - start < 10_000) {
    const snapshot = (primaryContainer().textContent ?? "").trim();
    if (isReady() && snapshot === prevSnapshot) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= STABLE_MS) break;
    } else {
      stableSince = null; // not ready, or content just changed — reset the clock
    }
    prevSnapshot = snapshot;
    await sleep(300);
  }

  // Deliberately excludes bare "more"/"更多" — Instagram's own sidebar has a
  // nav item literally labeled "More" that a plain match on just "more"
  // collides with (confirmed live: it opened the settings menu instead of
  // expanding a caption). Only match phrases specific enough to caption
  // toggles that real site nav wouldn't also use verbatim.
  const EXPAND_LABELS = ["see more", "...more", "… more", "查看更多", "顯示更多", "もっと見る", "続きを読む"];
  // A few passes: some UIs re-render after the first click and reveal a
  // second toggle (e.g. a longer caption that expands in stages).
  for (let pass = 0; pass < 3; pass++) {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("span, div[role='button'], a"));
    for (const el of candidates) {
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .trim()
        .toLowerCase();
      if (!EXPAND_LABELS.includes(ownText)) continue;
      // skip real navigation links — the toggle is always a JS-driven span/button
      if (el.tagName === "A" && (el as HTMLAnchorElement).href) continue;
      // skip anything inside site chrome (nav/menu/dialog) — caption toggles
      // live inside the post body, never inside navigation or a popup menu
      if (el.closest("nav, [role='navigation'], [role='menu'], [role='dialog']")) continue;
      el.click();
    }
    await sleep(500);
  }
}

async function expandCaptions(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, func: expandCaptionsInPage });
}

async function capturePageHtml(tabId: number): Promise<string> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.documentElement.outerHTML,
  });
  const html = results[0]?.result;
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("could not capture page HTML");
  }
  return html;
}

async function save(): Promise<void> {
  const settings = await getSettings();
  if (!settings.apiKey) {
    setStatus("err", "No API key configured.");
    hintEl.innerHTML = '<a href="#" id="open-options">Open settings</a> and paste your ingest key.';
    document.getElementById("open-options")?.addEventListener("click", (e) => {
      e.preventDefault();
      void chrome.runtime.openOptionsPage();
    });
    return;
  }

  const tab = await activeTab();
  if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
    setStatus("err", "This page can't be saved (not an http/https tab).");
    return;
  }

  saveBtn.disabled = true;
  setStatus("busy", isSocialCaptionSite(tab.url) ? "Saving… this can take ~30 s." : "Saving… this can take ~15 s.");
  hintEl.textContent = "Keep this popup open until it finishes.";

  let body: { url: string; html?: string };
  try {
    if (isYouTube(tab.url)) {
      body = { url: tab.url };
    } else {
      if (isSocialCaptionSite(tab.url)) await expandCaptions(tab.id);
      body = { url: tab.url, html: await capturePageHtml(tab.id) };
    }
  } catch (err) {
    setStatus("err", `Couldn't read the page: ${err instanceof Error ? err.message : err}`);
    saveBtn.disabled = false;
    return;
  }

  try {
    const resp = await fetch(`${settings.apiBase}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify(body),
    });
    const data = (await resp.json().catch(() => ({}))) as IngestResult[] | IngestError;

    if (resp.status === 401) {
      setStatus("err", "Invalid API key — check settings.");
    } else if (!resp.ok) {
      setStatus("err", (data as IngestError).error ?? `Server error (HTTP ${resp.status}).`);
    } else {
      const results = data as IngestResult[];
      if (results.length === 1) {
        const r = results[0]!;
        const partialNote = r.partial ? " — partial extraction, source was thin" : "";
        setStatus(
          "ok",
          r.status === "updated" ? `Updated ✓ ${r.title} (already in library)` : `Saved ✓ ${r.title}${partialNote}`,
        );
      } else {
        const saved = results.filter((r) => r.status === "saved").length;
        const updated = results.length - saved;
        const counts = [saved && `${saved} saved`, updated && `${updated} updated`].filter(Boolean).join(", ");
        setStatus("ok", `${results.length} recipes found ✓ (${counts}): ${results.map((r) => r.title).join(", ")}`);
      }
    }
  } catch {
    setStatus("err", "Could not reach the server — is it running?");
  } finally {
    hintEl.textContent = "";
    saveBtn.disabled = false;
  }
}

void (async () => {
  const tab = await activeTab();
  titleEl.textContent = tab?.title ?? tab?.url ?? "(no active tab)";
  saveBtn.addEventListener("click", () => void save());
})();
