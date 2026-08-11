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

describe("Anthropic probing", () => {
  it("fetchRemoteModels reads display_name and keys off the header", async () => {
    const calls = mockFetch({
      data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }, { id: "bare-id" }],
    });
    const models = await fetchRemoteModels("", "secret-key", "anthropic");
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0].url).not.toContain("secret-key");
    expect(calls[0].headers.get("x-api-key")).toBe("secret-key");
    expect(calls[0].headers.get("anthropic-version")).toBe("2023-06-01");
    expect(models).toEqual([
      { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      // No display_name — fall back to the id rather than showing nothing.
      { id: "bare-id", name: "bare-id" },
    ]);
  });

  it("testProviderConnection succeeds instead of reporting an unknown standard", async () => {
    mockFetch({ data: [] });
    // Before the anthropic branch existed this fell through to the
    // "Unknown API standard" arm and reported failure on a working provider.
    await expect(
      testProviderConnection("https://api.anthropic.com/v1", "secret-key", "anthropic"),
    ).resolves.toMatchObject({ ok: true });
  });

  it("testProviderConnection surfaces the status and body on failure", async () => {
    mockFetch({ error: { message: "invalid x-api-key" } }, false);
    await expect(
      testProviderConnection("https://api.anthropic.com/v1", "bad", "anthropic"),
    ).resolves.toMatchObject({ ok: false });
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
