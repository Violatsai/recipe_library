import { describe, expect, it } from "vitest";
import { isSocialCaptionSite } from "../src/shared.js";

describe("isSocialCaptionSite", () => {
  it("matches the caption-preview hosts, including TikTok", () => {
    expect(isSocialCaptionSite("https://www.facebook.com/someone/posts/1")).toBe(true);
    expect(isSocialCaptionSite("https://www.instagram.com/reel/abc/")).toBe(true);
    expect(isSocialCaptionSite("https://www.threads.net/@a/post/b")).toBe(true);
    expect(isSocialCaptionSite("https://www.tiktok.com/@cook/video/123?web_id=1")).toBe(true);
  });

  it("leaves ordinary sites and lookalike hosts on the plain web path", () => {
    expect(isSocialCaptionSite("https://cookieandkate.com/best-lentil-soup-recipe/")).toBe(false);
    expect(isSocialCaptionSite("https://nottiktok.com/@cook/video/123")).toBe(false);
    expect(isSocialCaptionSite("not a url")).toBe(false);
  });
});
