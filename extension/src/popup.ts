import { getSettings, isSocialCaptionSite, isYouTube } from "./shared.js";

/**
 * Popup save flow:
 *   YouTube tab        → POST { url } to /api/ingest directly (server handles
 *                         meta/link/transcript; no client-side capture, so no
 *                         staleness risk).
 *   social-caption tab → expand any collapsed caption, capture HTML, then
 *                         POST to /api/ingest-preview and show what was
 *                         found before saving anything. The user confirms
 *                         or cancels.
 *                         (Facebook/Instagram/Threads: these apps hydrate
 *                         post content asynchronously and can leave a
 *                         PREVIOUS post's content in the DOM while a new one
 *                         loads client-side — confirmed live, more than
 *                         once, that DOM-timing heuristics alone aren't
 *                         reliable enough here. A forced reload from the
 *                         popup would fix the staleness at the root, but
 *                         Chrome appears to close the popup as a side effect
 *                         of it reloading its own anchor tab — confirmed
 *                         live: the async flow died before ever reaching the
 *                         network call. So the popup asks the user to
 *                         refresh the page themselves before saving instead
 *                         (see the standing hint below); the preview step
 *                         is the safety net for anything that still slips
 *                         through.)
 *   any other tab      → POST { url, html } directly, same as before.
 *
 * Known limitation (accepted in the plan): the fetch runs in the popup, so the
 * popup must stay open until the response arrives. The hint text tells the user.
 */

const saveBtn = document.getElementById("save") as HTMLButtonElement;
const titleEl = document.getElementById("page-title")!;
const statusEl = document.getElementById("status")!;
const hintEl = document.getElementById("hint")!;
const previewEl = document.getElementById("preview") as HTMLDivElement;
const previewTitlesEl = document.getElementById("preview-titles") as HTMLUListElement;
const confirmBtn = document.getElementById("confirm") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel") as HTMLButtonElement;

function setStatus(kind: "ok" | "err" | "busy" | "", text: string): void {
  statusEl.className = kind;
  statusEl.textContent = text;
}

// The fetch runs in the popup itself, so it dies the moment the popup
// closes — including just switching tabs, which steals focus and closes it.
const STAY_HINT = "Stay on this tab and keep this popup open — switching tabs cancels the save.";

interface IngestResult {
  status: "saved" | "updated";
  title: string;
  partial: boolean;
}

interface IngestPreviewResult {
  title: string;
  partial: boolean;
}

interface IngestError {
  error?: string;
}

interface IngestBody {
  url: string;
  html?: string;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Runs in the page's own context via chrome.scripting.executeScript, so it
 *  must be fully self-contained (no closures over outer-scope variables).
 *
 *  Two problems this solves, confirmed live against real posts:
 *   1. These apps hydrate the actual post content asynchronously — right
 *      after a fresh load the DOM is just nav chrome (sidebar, "Messages"
 *      widget) with no post text yet. Capturing HTML at that point produces
 *      an empty extraction. So: poll the primary content container until it
 *      has a meaningful amount of text, or a timeout elapses.
 *   2. Facebook (and sometimes Instagram) collapse long captions behind a
 *      "see more"/"查看更多" toggle whose text isn't in the DOM until
 *      clicked. So: once content has loaded, click any such toggle.
 */
async function expandCaptionsInPage(): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const primaryContainer = (): Element =>
    document.querySelector("article") ?? document.querySelector("main") ?? document.body;

  const start = Date.now();
  while ((primaryContainer().textContent ?? "").trim().length < 400 && Date.now() - start < 8000) {
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

let pendingBody: IngestBody | null = null;
let currentTabUrl = "";

/** Standing reminder for social-caption sites — since the popup can't safely
 *  reload the tab itself (confirmed live: Chrome appears to close the popup
 *  as a side effect, killing the save mid-flight before it ever reaches the
 *  network), refreshing is on the user when it's actually needed: right
 *  after browsing from one post straight to another in the same tab. */
function setSocialHint(url: string): void {
  hintEl.textContent = isSocialCaptionSite(url)
    ? "Tip: if this tab was showing a different post a moment ago, refresh the page (⌘R) before saving."
    : "";
}

function showPreview(body: IngestBody, results: IngestPreviewResult[]): void {
  pendingBody = body;
  previewTitlesEl.innerHTML = "";
  for (const r of results) {
    const li = document.createElement("li");
    li.textContent = r.title + (r.partial ? " (partial)" : "");
    previewTitlesEl.appendChild(li);
  }
  saveBtn.hidden = true;
  previewEl.hidden = false;
  hintEl.textContent = "";
}

function resetToIdle(): void {
  pendingBody = null;
  previewEl.hidden = true;
  saveBtn.hidden = false;
  saveBtn.disabled = false;
  setSocialHint(currentTabUrl);
}

function reportIngestResults(results: IngestResult[]): void {
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

async function doFullSave(body: IngestBody): Promise<void> {
  const settings = await getSettings();
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
      reportIngestResults(data as IngestResult[]);
    }
  } catch {
    setStatus("err", "Could not reach the server — is it running?");
  }
}

async function doPreview(body: IngestBody): Promise<void> {
  const settings = await getSettings();
  try {
    const resp = await fetch(`${settings.apiBase}/api/ingest-preview`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify(body),
    });
    const data = (await resp.json().catch(() => ({}))) as IngestPreviewResult[] | IngestError;
    if (resp.status === 401) {
      setStatus("err", "Invalid API key — check settings.");
    } else if (!resp.ok) {
      setStatus("err", (data as IngestError).error ?? `Server error (HTTP ${resp.status}).`);
    } else {
      const results = data as IngestPreviewResult[];
      if (results.length === 0) {
        setStatus("err", "No recipe found on this page.");
      } else {
        setStatus("", "");
        showPreview(body, results);
      }
    }
  } catch {
    setStatus("err", "Could not reach the server — is it running?");
  }
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
  currentTabUrl = tab.url;

  const social = isSocialCaptionSite(tab.url);
  saveBtn.disabled = true;
  setStatus("busy", social ? "Checking the page… this can take ~20 s." : "Saving… this can take ~15 s.");
  hintEl.textContent = STAY_HINT;

  try {
    if (isYouTube(tab.url)) {
      await doFullSave({ url: tab.url });
      saveBtn.disabled = false;
    } else if (social) {
      await expandCaptions(tab.id);
      const html = await capturePageHtml(tab.id);
      setStatus("busy", "Checking what's on the page…");
      await doPreview({ url: tab.url, html });
      // showPreview()/doPreview()'s error path both leave saveBtn visible —
      // re-enable it unless a preview is now showing (save stays hidden then).
      if (previewEl.hidden) {
        saveBtn.disabled = false;
        setSocialHint(tab.url);
      }
    } else {
      const html = await capturePageHtml(tab.id);
      await doFullSave({ url: tab.url, html });
      saveBtn.disabled = false;
    }
  } catch (err) {
    setStatus("err", `Couldn't read the page: ${err instanceof Error ? err.message : err}`);
    saveBtn.disabled = false;
    setSocialHint(tab.url);
  }
}

async function confirmSave(): Promise<void> {
  if (!pendingBody) return;
  const body = pendingBody;
  previewEl.hidden = true;
  saveBtn.hidden = false;
  saveBtn.disabled = true;
  setStatus("busy", "Saving…");
  await doFullSave(body);
  pendingBody = null;
  saveBtn.disabled = false;
}

function cancel(): void {
  resetToIdle();
  setStatus("", "");
}

void (async () => {
  const tab = await activeTab();
  titleEl.textContent = tab?.title ?? tab?.url ?? "(no active tab)";
  if (tab?.url) {
    currentTabUrl = tab.url;
    setSocialHint(tab.url);
  }
  saveBtn.addEventListener("click", () => void save());
  confirmBtn.addEventListener("click", () => void confirmSave());
  cancelBtn.addEventListener("click", cancel);
})();
