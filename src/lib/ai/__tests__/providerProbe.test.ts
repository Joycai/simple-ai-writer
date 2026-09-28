import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchRemoteModels, testProviderConnection } from "../providerProbe";

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

describe("Responses-family probing", () => {
  it("counts the shared /models list like the Chat Completions half", async () => {
    const calls = mockFetch({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.6-sol" }] });
    const result = await testProviderConnection("", "secret-key", "openai_responses");
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.openai.com/v1/models");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer secret-key");
    expect(result.ok && result.message).toContain("2");
  });

  it("falls back to POST /responses on a relay without /models", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (u.includes("/models")) return new Response("<html>Not Found</html>", { status: 404 });
        // A New API relay refuses a made-up model with 503 + its own JSON
        // envelope (docs/api/responses.md §6) — the API spoke, so it counts.
        return new Response(
          JSON.stringify({ error: { code: "model_not_found", message: "No available channel for model __connection_probe__", type: "new_api_error" } }),
          { status: 503 },
        );
      }),
    );
    const result = await testProviderConnection("https://relay.example.com/v1", "k", "openai_responses_compat");
    expect(result.ok).toBe(true);
    expect(calls[1].url).toBe("https://relay.example.com/v1/responses");
    expect(calls[1].method).toBe("POST");
    // This family's own shape, not a Chat Completions body — a Responses-only
    // relay need not serve /chat/completions at all.
    expect(calls[1].body).toMatchObject({ input: "hi", max_output_tokens: 16, store: false });
    expect(calls[1].body).not.toHaveProperty("messages");
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

  // 火山方舟 Plan's Anthropic route: /v1/models says 401 to a key that
  // /v1/messages accepts. The completion probe gets the last word.
  it("asks the completion endpoint when /models refuses the key", async () => {
    const calls = mockMissingModels(401, {
      status: 404,
      body: JSON.stringify({ error: { code: "UnsupportedModel", message: "The requested model does not support the agent plan feature." } }),
    });
    const result = await testProviderConnection("https://ark.cn-beijing.volces.com/api/plan", "k", "anthropic_compat");
    expect(result.ok).toBe(true);
    expect(calls[1].url).toBe("https://ark.cn-beijing.volces.com/api/plan/v1/messages");
    // …and a key the completion endpoint refuses too is still a failure.
    vi.unstubAllGlobals();
    mockMissingModels(401, { status: 401, body: JSON.stringify({ error: { message: "invalid api key" } }) });
    await expect(
      testProviderConnection("https://ark.cn-beijing.volces.com/api/plan", "bad", "anthropic_compat"),
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

describe("DashScope native probing", () => {
  const BASE = "https://maas.qianwenaiapi.com/api/v1";

  /** `/models` pages as 百炼 serves them: `total` beside at most `size` rows. */
  function mockNativeModels(total: number) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(String(url));
      urls.push(String(url));
      const size = Number(u.searchParams.get("page_size"));
      const page = Number(u.searchParams.get("page_no") ?? "1");
      const from = (page - 1) * size;
      const models = Array.from({ length: Math.max(0, Math.min(size, total - from)) }, (_, i) => ({
        model: `m-${from + i}`, name: i === 0 ? "" : `Model ${from + i}`,
      }));
      return new Response(JSON.stringify({ output: { total, page_no: page, page_size: size, models } }), { status: 200 });
    }));
    return urls;
  }

  it("reads every page of the model list", async () => {
    const urls = mockNativeModels(218);
    const models = await fetchRemoteModels(BASE, "k", "dashscope_compat");
    expect(urls).toEqual([1, 2, 3].map((n) => `${BASE}/models?page_size=100&page_no=${n}`));
    expect(models).toHaveLength(218);
    expect(models[0]).toEqual({ id: "m-0", name: "m-0" });
    expect(models[217]).toEqual({ id: "m-217", name: "Model 217" });
  });

  it("keeps paging while pages are full when the total is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const page = Number(new URL(String(url)).searchParams.get("page_no"));
      const n = page < 3 ? 100 : 7;
      return new Response(JSON.stringify({ output: { models: Array.from({ length: n }, (_, i) => ({ model: `p${page}-${i}` })) } }), { status: 200 });
    }));
    await expect(fetchRemoteModels(BASE, "k", "dashscope_compat")).resolves.toHaveLength(207);
  });

  it("stops on an empty page even if the total says otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ output: { total: 9999, models: [] } }), { status: 200 })));
    await expect(fetchRemoteModels(BASE, "k", "dashscope_compat")).resolves.toEqual([]);
  });

  it("counts the catalogue from a one-row page", async () => {
    const urls = mockNativeModels(518);
    const result = await testProviderConnection(BASE, "k", "dashscope_compat");
    expect(urls).toEqual([`${BASE}/models?page_size=1`]);
    expect(result).toMatchObject({ ok: true });
    expect((result as { message: string }).message).toContain("518");
  });

  it("falls back to the native endpoint, and reads 百炼's refusal of a made-up model as reachable", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).includes("/models")) return new Response("<html>Not Found</html>", { status: 404 });
      return new Response(JSON.stringify({ code: "InvalidParameter", message: "Model not exist.", request_id: "r" }), { status: 404 });
    }));
    const result = await testProviderConnection(BASE, "k", "dashscope_compat");
    expect(result.ok).toBe(true);
    expect(calls[1].url).toBe(`${BASE}/services/aigc/multimodal-generation/generation`);
    expect(calls[1].body).toMatchObject({ input: { messages: [{ role: "user", content: "hi" }] }, parameters: { max_tokens: 1 } });
  });
});
