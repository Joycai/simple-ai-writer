import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchRemoteModels, testProviderConnection } from "../ai/providerProbe";

function mockFetch(body: unknown, ok = true) {
  const calls: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(body), { status: ok ? 200 : 401 });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gemini probing sends the key as a header, never in the URL", () => {
  it("fetchRemoteModels", async () => {
    const calls = mockFetch({ models: [] });
    await fetchRemoteModels("", "secret-key", "gemini");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain("secret-key");
    expect(calls[0].url).not.toContain("key=");
    expect(calls[0].headers.get("x-goog-api-key")).toBe("secret-key");
  });

  it("testProviderConnection", async () => {
    const calls = mockFetch({ models: [] });
    await testProviderConnection("", "secret-key", "gemini");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain("secret-key");
    expect(calls[0].url).not.toContain("key=");
    expect(calls[0].url).toContain("pageSize=1");
    expect(calls[0].headers.get("x-goog-api-key")).toBe("secret-key");
  });
});

describe("OpenAI-compatible probing is unaffected", () => {
  it("still authenticates via the Authorization header", async () => {
    const calls = mockFetch({ data: [] });
    await testProviderConnection("https://api.example.com/v1", "secret-key", "openai");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer secret-key");
    expect(calls[0].url).not.toContain("secret-key");
  });
});
