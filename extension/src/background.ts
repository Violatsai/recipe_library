import {
  getSettings,
  isYouTube,
  type AcceptedIngestionJob,
  type QueueRecipeMessage,
  type QueueRecipeResponse,
  type Settings,
} from "./shared.js";

interface CapturedPage {
  url: string;
  html: string;
}

export interface QueueCaptureDependencies {
  getSettings(): Promise<Settings>;
  captureTab(tabId: number): Promise<CapturedPage>;
  fetch: typeof fetch;
}

function documentIdentity(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.toString();
}

async function captureTab(tabId: number): Promise<CapturedPage> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      url: window.location.href,
      html: document.documentElement.outerHTML,
    }),
  });
  const captured = results[0]?.result;
  if (!captured || typeof captured.url !== "string" || typeof captured.html !== "string" || !captured.html) {
    throw new Error("could not capture page HTML");
  }
  return captured;
}

const defaultDependencies: QueueCaptureDependencies = {
  getSettings,
  captureTab,
  fetch: globalThis.fetch.bind(globalThis),
};

/** Capture (when needed) and durably hand one source to the local server. */
export async function queueRecipeCapture(
  message: QueueRecipeMessage,
  deps: QueueCaptureDependencies = defaultDependencies,
): Promise<QueueRecipeResponse> {
  const settings = await deps.getSettings();
  if (!settings.apiKey) {
    return { ok: false, code: "NO_API_KEY", message: "No API key configured." };
  }

  let html = message.html;
  if (!html && !isYouTube(message.url)) {
    let captured: CapturedPage;
    try {
      captured = await deps.captureTab(message.tabId);
    } catch {
      return {
        ok: false,
        code: "CAPTURE_FAILED",
        message: "Could not read the page. Reload it and try again.",
      };
    }
    if (documentIdentity(captured.url) !== documentIdentity(message.url)) {
      return {
        ok: false,
        code: "PAGE_CHANGED",
        message: "The tab navigated before it could be captured. Try saving the new page again.",
      };
    }
    html = captured.html;
  }

  let response: Response;
  try {
    response = await deps.fetch(`${settings.apiBase}/api/ingestion-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify({ url: message.url, title: message.title, html }),
    });
  } catch {
    return {
      ok: false,
      code: "NETWORK",
      message: "Could not reach the server — is it running?",
    };
  }

  const body = await response.json().catch(() => ({})) as Partial<AcceptedIngestionJob> & { error?: string };
  if (response.status === 401) {
    return { ok: false, code: "AUTH", message: "Invalid API key — check settings." };
  }
  if (!response.ok || !body.id || !body.captured_title || !body.status || !body.disposition) {
    return {
      ok: false,
      code: "SERVER",
      message: body.error ?? `Server error (HTTP ${response.status}).`,
    };
  }
  return { ok: true, job: body as AcceptedIngestionJob };
}

function setBadge(state: "busy" | "ok" | "error"): void {
  const badge = state === "busy"
    ? { text: "…", color: "#4B6B39" }
    : state === "ok"
      ? { text: "✓", color: "#3C7A2D" }
      : { text: "!", color: "#B03A2E" };
  void chrome.action.setBadgeBackgroundColor({ color: badge.color });
  void chrome.action.setBadgeText({ text: badge.text });
  if (state === "ok") {
    setTimeout(() => void chrome.action.setBadgeText({ text: "" }), 2_500);
  }
}

function isQueueRecipeMessage(value: unknown): value is QueueRecipeMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QueueRecipeMessage>;
  return candidate.type === "queue-recipe"
    && typeof candidate.tabId === "number"
    && typeof candidate.url === "string";
}

// Use callback + literal `true` for broad Chrome compatibility: it keeps the
// message event alive while the service worker captures and posts the job.
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isQueueRecipeMessage(message)) return false;
    setBadge("busy");
    void queueRecipeCapture(message).then((response) => {
      setBadge(response.ok ? "ok" : "error");
      sendResponse(response);
    }).catch(() => {
      setBadge("error");
      sendResponse({
        ok: false,
        code: "SERVER",
        message: "Could not queue this recipe.",
      } satisfies QueueRecipeResponse);
    });
    return true;
  });
}
