/**
 * Server-side page fetch. Returns HTML for the enrichment step.
 *
 * If the caller already supplied HTML (the extension's client-side capture,
 * which sidesteps bot walls), we use it directly. Otherwise we fetch. Any
 * failure — network error, non-2xx, or a suspected bot wall — throws
 * NeedsHtmlError, which the route surfaces as 422 { error: "NEEDS_HTML" } so
 * the extension can retry with the page HTML it already has.
 */

export class NeedsHtmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsHtmlError";
  }
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;

function looksLikeBotWall(html: string): boolean {
  if (html.length < 500) return true;
  const markers = [
    "Just a moment...",
    "Attention Required! | Cloudflare",
    "cf-browser-verification",
    "cf-challenge",
    "Enable JavaScript and cookies to continue",
    "/cdn-cgi/challenge-platform/",
  ];
  return markers.some((m) => html.includes(m));
}

export async function fetchPage(url: string, providedHtml?: string): Promise<string> {
  if (providedHtml && providedHtml.trim().length > 0) return providedHtml;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": DESKTOP_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    throw new NeedsHtmlError(`fetch failed for ${url}: ${err instanceof Error ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) throw new NeedsHtmlError(`fetch ${url} returned HTTP ${resp.status}`);
  const html = await resp.text();
  if (looksLikeBotWall(html)) throw new NeedsHtmlError(`suspected bot wall at ${url}`);
  return html;
}
