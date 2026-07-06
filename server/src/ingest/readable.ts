import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

/**
 * Fallback for pages without JSON-LD: strip nav/ads/boilerplate and return the
 * main article title + text for the enrichment step to extract from.
 */
export function extractReadable(html: string, url: string): { title: string; textContent: string } {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  return {
    title: article?.title ?? "",
    textContent: (article?.textContent ?? "").trim(),
  };
}
