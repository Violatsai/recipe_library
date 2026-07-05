import { describe, expect, it } from "vitest";
import { detectSource, normalizeUrl } from "../src/ingest/normalizeUrl.js";

describe("normalizeUrl — web pages", () => {
  it("strips utm_* and known tracking params", () => {
    expect(
      normalizeUrl("https://example.com/recipe?utm_source=fb&utm_medium=x&id=5&fbclid=abc"),
    ).toBe("https://example.com/recipe?id=5");
  });

  it("strips si / gclid / igshid / feature", () => {
    expect(
      normalizeUrl("https://example.com/r?gclid=1&igshid=2&si=3&feature=share&keep=yes"),
    ).toBe("https://example.com/r?keep=yes");
  });

  it("sorts remaining params for a stable ordering", () => {
    expect(normalizeUrl("https://example.com/r?b=2&a=1&c=3")).toBe(
      "https://example.com/r?a=1&b=2&c=3",
    );
  });

  it("drops the fragment", () => {
    expect(normalizeUrl("https://example.com/r?a=1#instructions")).toBe(
      "https://example.com/r?a=1",
    );
  });

  it("lowercases the host but preserves path case", () => {
    expect(normalizeUrl("https://EXAMPLE.com/My-Recipe")).toBe(
      "https://example.com/My-Recipe",
    );
  });

  it("two links differing only by tracking + order normalize equal (dedup)", () => {
    const a = normalizeUrl("https://blog.test/pad-thai?utm_campaign=x&ref=1");
    const b = normalizeUrl("https://blog.test/pad-thai?ref=1&fbclid=zzz");
    expect(a).toBe(b);
  });
});

describe("normalizeUrl — YouTube canonicalization", () => {
  const canonical = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  it("youtu.be short link with tracking", () => {
    expect(normalizeUrl("https://youtu.be/dQw4w9WgXcQ?si=abc123")).toBe(canonical);
  });

  it("watch URL with a timestamp", () => {
    expect(normalizeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe(canonical);
  });

  it("shorts form", () => {
    expect(normalizeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(canonical);
  });

  it("m.youtube.com host", () => {
    expect(normalizeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share")).toBe(
      canonical,
    );
  });
});

describe("detectSource", () => {
  it("recognizes YouTube hosts", () => {
    expect(detectSource("https://youtu.be/abc")).toBe("youtube");
    expect(detectSource("https://www.youtube.com/watch?v=abc")).toBe("youtube");
    expect(detectSource("https://m.youtube.com/watch?v=abc")).toBe("youtube");
  });

  it("treats everything else as web", () => {
    expect(detectSource("https://seriouseats.com/pad-thai")).toBe("web");
    expect(detectSource("https://notyoutube.com/x")).toBe("web"); // not a YouTube host
  });
});
