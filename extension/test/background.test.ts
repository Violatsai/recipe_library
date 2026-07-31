import { describe, expect, it, vi } from "vitest";
import {
  queueRecipeCapture,
  type QueueCaptureDependencies,
} from "../src/background.js";
import type { QueueRecipeMessage } from "../src/shared.js";

const accepted = {
  id: "11111111-1111-4111-8111-111111111111",
  captured_title: "Example Recipe",
  status: "queued",
  disposition: "created",
};

function message(overrides: Partial<QueueRecipeMessage> = {}): QueueRecipeMessage {
  return {
    type: "queue-recipe",
    tabId: 42,
    url: "https://example.com/recipe",
    title: "Example Recipe",
    ...overrides,
  };
}

function dependencies(overrides: Partial<QueueCaptureDependencies> = {}) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(accepted), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  );
  const captureMock = vi.fn(async () => ({
    url: "https://example.com/recipe",
    html: "<html><body>captured recipe</body></html>",
  }));
  const deps: QueueCaptureDependencies = {
    getSettings: async () => ({ apiBase: "http://localhost:3001", apiKey: "test-key" }),
    captureTab: captureMock,
    fetch: fetchMock as unknown as typeof fetch,
    ...overrides,
  };
  return { deps, fetchMock, captureMock };
}

describe("queueRecipeCapture", () => {
  it("captures an ordinary page and submits it to the durable job endpoint", async () => {
    const { deps, fetchMock, captureMock } = dependencies();
    const result = await queueRecipeCapture(message(), deps);

    expect(result).toEqual({ ok: true, job: accepted });
    expect(captureMock).toHaveBeenCalledWith(42);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:3001/api/ingestion-jobs");
    expect(init?.headers).toEqual({ "content-type": "application/json", "x-api-key": "test-key" });
    expect(JSON.parse(String(init?.body))).toEqual({
      url: "https://example.com/recipe",
      title: "Example Recipe",
      html: "<html><body>captured recipe</body></html>",
    });
  });

  it("queues YouTube URL-only without attempting page capture", async () => {
    const { deps, fetchMock, captureMock } = dependencies();
    const result = await queueRecipeCapture(message({
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    }), deps);

    expect(result.ok).toBe(true);
    expect(captureMock).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).toEqual({
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      title: "Example Recipe",
    });
  });

  it("uses a confirmed social snapshot without recapturing the tab", async () => {
    const { deps, fetchMock, captureMock } = dependencies();
    const html = "<html><body>confirmed social caption</body></html>";
    await queueRecipeCapture(message({ url: "https://www.instagram.com/p/example", html }), deps);

    expect(captureMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      url: "https://www.instagram.com/p/example",
      title: "Example Recipe",
      html,
    });
  });

  it("does not enqueue if the tab navigates before snapshot capture", async () => {
    const { deps, fetchMock } = dependencies({
      captureTab: async () => ({ url: "https://example.com/different", html: "<html></html>" }),
    });
    const result = await queueRecipeCapture(message(), deps);

    expect(result).toEqual({
      ok: false,
      code: "PAGE_CHANGED",
      message: "The tab navigated before it could be captured. Try saving the new page again.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing keys, authentication errors, and network failures safely", async () => {
    const noKey = dependencies({
      getSettings: async () => ({ apiBase: "http://localhost:3001", apiKey: "" }),
    });
    await expect(queueRecipeCapture(message(), noKey.deps)).resolves.toEqual(
      { ok: false, code: "NO_API_KEY", message: "No API key configured." },
    );

    const auth = dependencies({
      fetch: vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })) as unknown as typeof fetch,
    });
    await expect(queueRecipeCapture(message(), auth.deps)).resolves.toEqual(
      { ok: false, code: "AUTH", message: "Invalid API key — check settings." },
    );

    const offline = dependencies({
      fetch: vi.fn(async () => { throw new Error("private network detail"); }) as unknown as typeof fetch,
    });
    await expect(queueRecipeCapture(message(), offline.deps)).resolves.toEqual(
      { ok: false, code: "NETWORK", message: "Could not reach the server — is it running?" },
    );
  });
});
