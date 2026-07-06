import { getSettings, isYouTube } from "./shared.js";

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

interface IngestResponse {
  status?: "saved" | "updated";
  title?: string;
  partial?: boolean;
  error?: string;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
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
  setStatus("busy", "Saving… this can take ~15 s.");
  hintEl.textContent = "Keep this popup open until it finishes.";

  let body: { url: string; html?: string };
  try {
    body = isYouTube(tab.url)
      ? { url: tab.url }
      : { url: tab.url, html: await capturePageHtml(tab.id) };
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
    const data = (await resp.json().catch(() => ({}))) as IngestResponse;

    if (resp.status === 401) {
      setStatus("err", "Invalid API key — check settings.");
    } else if (!resp.ok) {
      setStatus("err", data.error ?? `Server error (HTTP ${resp.status}).`);
    } else if (data.status === "updated") {
      setStatus("ok", `Updated ✓ ${data.title ?? ""} (already in library)`);
    } else {
      const partialNote = data.partial ? " — partial extraction, source was thin" : "";
      setStatus("ok", `Saved ✓ ${data.title ?? ""}${partialNote}`);
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
