import { describe, expect, it } from "vitest";
import { extractTikTokCaption } from "../src/ingest/tiktok.js";

// Mirrors the state shape of a real TikTok video page (verified live against
// tiktok.com/@ourhealthy_kitchen/video/7506640293207248158, 2026-08-13).
function tiktokPage(itemStruct: Record<string, unknown>): string {
  const state = {
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": { itemInfo: { itemStruct } },
    },
  };
  return `<html><head><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(state)}</script></head><body></body></html>`;
}

const URL_A = "https://www.tiktok.com/@cook/video/111";

describe("extractTikTokCaption", () => {
  it("pulls the caption and author from the hydration-state JSON", () => {
    const html = tiktokPage({
      id: "111",
      desc: "Full recipe: 2 onions, 1 can beans. Bake at 400F.",
      author: { uniqueId: "cook" },
    });
    expect(extractTikTokCaption(html, URL_A)).toEqual({
      author: "cook",
      caption: "Full recipe: 2 onions, 1 can beans. Bake at 400F.",
    });
  });

  it("rejects stale SPA state from a different post", () => {
    const html = tiktokPage({ id: "222", desc: "a different video's caption" });
    expect(extractTikTokCaption(html, URL_A)).toBeNull();
  });

  it("returns null for an empty caption", () => {
    expect(extractTikTokCaption(tiktokPage({ id: "111", desc: "  " }), URL_A)).toBeNull();
  });

  it("returns null when the page has no state script", () => {
    expect(extractTikTokCaption("<html><body>hi</body></html>", URL_A)).toBeNull();
  });

  it("returns null for malformed state JSON", () => {
    const html =
      '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{oops</script>';
    expect(extractTikTokCaption(html, URL_A)).toBeNull();
  });

  it("returns null for a non-post URL", () => {
    const html = tiktokPage({ id: "111", desc: "caption" });
    expect(extractTikTokCaption(html, "https://www.tiktok.com/@cook")).toBeNull();
  });
});
