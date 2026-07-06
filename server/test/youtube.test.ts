import { describe, expect, it } from "vitest";
import { youtubeVideoId } from "../src/ingest/normalizeUrl.js";
import { findRecipeLink } from "../src/ingest/youtube.js";

describe("findRecipeLink", () => {
  it("returns the first non-social link", () => {
    const desc = `Full recipe on my blog!
https://www.instagram.com/somecook
https://mycookingblog.com/best-pad-thai
https://linktr.ee/somecook`;
    expect(findRecipeLink(desc)).toBe("https://mycookingblog.com/best-pad-thai");
  });

  it("skips socials, link hubs, shorteners, amazon, and youtube itself", () => {
    const desc = `Follow me!
https://youtu.be/other-video
https://www.tiktok.com/@cook
https://linktr.ee/cook
https://amzn.to/mywok
https://bit.ly/opaque
https://www.patreon.com/cook`;
    expect(findRecipeLink(desc)).toBeNull();
  });

  it("strips trailing punctuation stuck to the URL", () => {
    expect(findRecipeLink("Recipe here: https://blog.test/noodles.")).toBe(
      "https://blog.test/noodles",
    );
    expect(findRecipeLink("(see https://blog.test/soup!)")).toBe("https://blog.test/soup");
  });

  it("returns null when there are no links at all", () => {
    expect(findRecipeLink("2 cups flour, 1 egg, mix and bake at 350F")).toBeNull();
  });

  it("does not treat subdomains of blocked hosts as recipe links", () => {
    expect(findRecipeLink("https://m.youtube.com/watch?v=abc")).toBeNull();
    expect(findRecipeLink("https://shop.amazon.com/thing")).toBeNull();
  });
});

describe("youtubeVideoId", () => {
  it("extracts from all supported URL forms", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=x")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for non-YouTube or malformed input", () => {
    expect(youtubeVideoId("https://example.com/watch?v=abc")).toBeNull();
    expect(youtubeVideoId("not a url")).toBeNull();
  });
});
