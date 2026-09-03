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

  it("reports a credit gate as failure, with the relay's own message", async () => {
    // OrcaRouter on an empty account (verified live): /v1/models is fine, the
    // completion answers 402 with an OpenAI-shaped error before reading the
    // model. The endpoint spoke and the key is right, but nothing will run.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/models")
          ? new Response("{}", { status: 404 })
          : new Response(
              JSON.stringify({ error: { message: "You're out of credits — this request needs $0.0006.", code: "insufficient_user_quota" } }),
              { status: 402 },
            ),
      ),
    );
    const result = await testProviderConnection("https://relay.example", "k", "openai_compat");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("402");
    expect((result as { error: string }).error).toContain("out of credits");
  });

  it("fetchRemoteModels keeps only the models a multi-protocol relay serves on this surface", async () => {
    // OrcaRouter's one catalogue, reached through the Claude-format preset:
    // bare host as the base (anthropicRoot appends /v1), Bearer as the key.
    const calls = mockFetch({
      data: [
        { id: "anthropic/claude-sonnet-4.6", supported_endpoint_types: ["anthropic", "openai"] },
        { id: "openai/gpt-4o", supported_endpoint_types: ["openai"] },
        // No declaration — the official list has none — stays in.
        { id: "undeclared" },
      ],
    });
    const models = await fetchRemoteModels("https://api.orcarouter.ai", "sk-orca-x", "anthropic_compat", "bearer");
    expect(calls[0].url).toBe("https://api.orcarouter.ai/v1/models");
    expect(calls[0].headers.get("authorization")).toBe("Bearer sk-orca-x");
    expect(calls[0].headers.get("x-api-key")).toBeNull();
    expect(models.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4.6", "undeclared"]);
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

describe("compat endpoints without /models", () => {
  /** Answers the models URL with `absent`, and anything else with `then`. */
  function mockMissingModels(absent: number, then: { status: number; body: string }) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        calls.push({
          url: u,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (u.includes("/models")) return new Response("<html>Not Found</html>", { status: absent });
        return new Response(then.body, { status: then.status });
      }),
    );
    return calls;
  }

  // Plenty of relays implement only the completion endpoint. Reporting the
  // missing model list as a connection failure told the author their key or
  // address was wrong when neither was.
  it("falls back to a completion probe and reads the rejection as success", async () => {
    const calls = mockMissingModels(404, {
      status: 404,
      body: JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: __connection_probe__" } }),
    });
    const result = await testProviderConnection(
      "https://relay.example.com",
      "k",
      "anthropic_compat",
    );
    expect(result.ok).toBe(true);
    expect(calls[1].url).toBe("https://relay.example.com/v1/messages");
    expect(calls[1].method).toBe("POST");
    // Costs nothing: a model that cannot exist, capped at one token.
    expect(calls[1].body).toMatchObject({ max_tokens: 1 });
  });

  it("still reports a bad key as failure, not as a missing model list", async () => {
    mockMissingModels(404, {
      status: 401,
      body: JSON.stringify({ error: { message: "invalid api key" } }),
    });
    await expect(
      testProviderConnection("https://relay.example.com", "bad", "anthropic_compat"),
    ).resolves.toMatchObject({ ok: false });
  });

  // The case the whole heuristic exists to catch: a base URL pointing at
  // something that isn't the API. It 404s like a missing model list does, but
  // answers in HTML rather than the protocol's error shape.
  it("reports a non-API endpoint as failure even though both calls 404", async () => {
    mockMissingModels(404, { status: 404, body: "<html>nginx</html>" });
    await expect(
      testProviderConnection("https://relay.example.com", "k", "anthropic_compat"),
    ).resolves.toMatchObject({ ok: false });
  });

  it("does not fall back on an official standard", async () => {
    const calls = mockMissingModels(404, { status: 200, body: "{}" });
    await expect(
      testProviderConnection("", "k", "anthropic"),
    ).resolves.toMatchObject({ ok: false });
    expect(calls).toHaveLength(1); // no completion probe
  });

  it("uses each family's own completion endpoint", async () => {
    const openai = mockMissingModels(404, {
      status: 400,
      body: JSON.stringify({ error: { message: "unknown model" } }),
    });
    await testProviderConnection("https://relay.example.com/v1", "k", "openai_compat");
    expect(openai[1].url).toBe("https://relay.example.com/v1/chat/completions");
    vi.unstubAllGlobals();

    const gemini = mockMissingModels(404, {
      status: 400,
      body: JSON.stringify({ error: { message: "unknown model" } }),
    });
    await testProviderConnection("https://relay.example.com/v1beta", "k", "gemini_compat");
    expect(gemini[1].url).toContain(":generateContent");
  });

  it("explains a missing model list instead of reporting a bare status", async () => {
    mockMissingModels(404, { status: 200, body: "{}" });
    await expect(
      fetchRemoteModels("https://relay.example.com", "k", "anthropic_compat"),
    ).rejects.toThrow(/model ID|模型 ID/);
  });
});
