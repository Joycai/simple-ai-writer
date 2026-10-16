import { afterEach, describe, expect, it, vi } from "vitest";
import { embed, rerank, retrievalUrl, embeddingLimits, cosine, type RetrievalConnection } from "../retrieval";
import { conversationalModels, modelUpsert, type Model } from "../configDb";
import { streamCompletion } from "../index";
import { parseRetrievalConfig } from "../retrievalConfig";

const conn: RetrievalConnection = { baseUrl: "http://localhost:11434/v1", apiKey: "", modelId: "anything",
  retrieval: { format: "openai-embedding", path: "/v1/embeddings" } };
const response = (data: unknown) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status: 200 })));
afterEach(() => vi.unstubAllGlobals());

describe("retrieval protocols", () => {
  it("orders OpenAI vectors by response index and sends no chat fields or empty authorization", async () => {
    response({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 8 } });
    const usage = vi.fn();
    expect(await embed(conn, ["a", "b"], new AbortController().signal, usage)).toEqual([[1, 0], [0, 1]]);
    const init = vi.mocked(fetch).mock.calls[0][1]!;
    expect(JSON.parse(init.body as string)).toEqual({ model: "anything", input: ["a", "b"], encoding_format: "float" });
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(usage).toHaveBeenCalledWith({ promptTokens: 8, outputUnits: undefined });
  });
  it("uses Ollama batch embeddings without silently truncating", async () => {
    response({ embeddings: [[1, 2]], prompt_eval_count: 3 });
    const native = { ...conn, retrieval: { format: "ollama-embedding" as const, path: "/api/embed" } };
    expect(await embed(native, ["a"], new AbortController().signal)).toEqual([[1, 2]]);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ model: "anything", input: ["a"], truncate: false });
  });
  it("sends independent DashScope text contents and reorders indexed vectors with native usage", async () => {
    const native = { ...conn, apiKey: "test-key", baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1", modelId: "qwen3-vl-embedding",
      retrieval: { format: "dashscope-multimodal-embedding" as const, path: "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding" } };
    response({ output: { embeddings: [{ index: 1, embedding: [0, 1], type: "vl" }, { index: 0, embedding: [1, 0], type: "vl" }] },
      usage: { input_tokens: 124, total_tokens: 124, image_tokens: 0 } });
    const usage = vi.fn();
    expect(await embed(native, ["query", "document"], new AbortController().signal, usage)).toEqual([[1, 0], [0, 1]]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://maas.qianwenaiapi.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding");
    expect(JSON.parse(init!.body as string)).toEqual({ model: "qwen3-vl-embedding", input: { contents: [{ text: "query" }, { text: "document" }] } });
    expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer test-key");
    expect(usage).toHaveBeenCalledWith({ promptTokens: 124, outputUnits: undefined });
    expect(embeddingLimits(native)).toEqual({ batchSize: 20, timeoutMs: 20_000 });
    expect(parseRetrievalConfig(JSON.stringify(native.retrieval))).toEqual(native.retrieval);
  });
  it.each([
    {}, { output: {} }, { output: { embeddings: [{ index: 0, embedding: [1] }] } },
    { output: { embeddings: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] } },
    { output: { embeddings: [{ index: 0, embedding: [1] }, { index: 1, embedding: [0] }] } },
    { output: { embeddings: [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }] } },
  ])("refuses incomplete or malformed DashScope batches without losing billed usage", async (data) => {
    response({ ...data, usage: { input_tokens: 12 } });
    const usage = vi.fn();
    await expect(embed({ ...conn, retrieval: { format: "dashscope-multimodal-embedding", path: "/native" } }, ["a", "b"], new AbortController().signal, usage)).rejects.toThrow();
    expect(usage).toHaveBeenCalledWith({ promptTokens: 12, outputUnits: undefined });
  });
  it.each([
    { data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] },
    { data: [{ index: 0, embedding: [0, 0] }] },
    { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }] },
    { data: [{ index: 3, embedding: [1] }] },
  ])("rejects unusable embedding responses while recording the request", async (data) => {
    response(data); const usage = vi.fn();
    await expect(embed(conn, ["a", "b"], new AbortController().signal, usage)).rejects.toThrow();
    expect(usage).toHaveBeenCalledOnce();
  });
  it("accepts only real rerank indices and sorts by relevance", async () => {
    response({ results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] });
    expect(await rerank(conn, "q", ["a", "b"], new AbortController().signal)).toEqual([{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }]);
    response({ results: [{ index: 2, relevance_score: 0.9 }] });
    await expect(rerank(conn, "q", ["a"], new AbortController().signal)).rejects.toThrow();
  });
  it("sends DashScope rerank's nested body and reads native results and token usage", async () => {
    response({ output: { results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] }, usage: { prompt_tokens: 37, total_tokens: 37 } });
    const usage = vi.fn();
    const native = { ...conn, modelId: "qwen3.7-text-rerank", baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1",
      retrieval: { format: "dashscope-rerank" as const, path: "/api/v1/services/rerank/text-rerank/text-rerank" } };
    expect(await rerank(native, "query", ["a", "b"], new AbortController().signal, usage)).toEqual([{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://maas.qianwenaiapi.com/api/v1/services/rerank/text-rerank/text-rerank");
    expect(JSON.parse(init!.body as string)).toEqual({ model: "qwen3.7-text-rerank", input: { query: "query", documents: ["a", "b"] }, parameters: { top_n: 2 } });
    expect(usage).toHaveBeenCalledWith({ promptTokens: 37, outputUnits: undefined });
    expect(parseRetrievalConfig(JSON.stringify(native.retrieval))).toEqual(native.retrieval);
  });
  it.each([
    {}, { output: {} }, { output: { results: [{ index: 2, relevance_score: 0.9 }] } },
    { output: { results: [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }] } },
    { output: { results: [{ index: 0, relevance_score: "0.9" }] } },
  ])("rejects malformed native rerank output while recording billed tokens", async (data) => {
    response({ ...data, usage: { total_tokens: 14 } });
    const usage = vi.fn();
    await expect(rerank({ ...conn, retrieval: { format: "dashscope-rerank", path: "/native" } }, "q", ["a", "b"], new AbortController().signal, usage)).rejects.toThrow();
    expect(usage).toHaveBeenCalledWith({ promptTokens: 14, outputUnits: undefined });
  });
  it("never forwards a channel key to a model-supplied host", () => {
    for (const path of ["https://evil.test/rerank", "//evil.test/rerank", "/\\evil.test/rerank", "/x?key=a"]) {
      expect(parseRetrievalConfig({ format: "cohere-rerank", path })).toBeUndefined();
      expect(() => retrievalUrl({ ...conn, retrieval: { format: "cohere-rerank", path } })).toThrow();
    }
    expect(retrievalUrl(conn)).toBe("http://localhost:11434/v1/embeddings");
  });
  it("preserves channel API prefixes for the default embedding path", () => {
    for (const baseUrl of ["https://ark.example/api/plan/v3", "https://ark.example/api/plan/v3/", "https://ark.example/api/plan/v3/chat/completions"]) {
      expect(retrievalUrl({ ...conn, baseUrl })).toBe("https://ark.example/api/plan/v3/embeddings");
    }
    expect(retrievalUrl({ ...conn, baseUrl: "http://localhost:8000" })).toBe("http://localhost:8000/v1/embeddings");
    expect(retrievalUrl({ ...conn, baseUrl: "https://relay.example/prefix", retrieval: { format: "openai-embedding", path: "/custom/embed" } })).toBe("https://relay.example/custom/embed");
  });
  it("uses the measured batch limit only for the Ark Agent Plan endpoint", () => {
    expect(embeddingLimits({ ...conn, baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/" }))
      .toEqual({ batchSize: 10, timeoutMs: 60_000 });
    for (const baseUrl of ["http://localhost:8000", "https://relay.example/api/plan/v3", "https://ark.cn-beijing.volces.com/api/v3"]) {
      expect(embeddingLimits({ ...conn, baseUrl, modelId: "doubao-embedding-vision" }))
        .toEqual({ batchSize: 32, timeoutMs: 20_000 });
    }
  });
  it("uses Qwen 3.7's published 20-text cap only on its official compatible endpoint", () => {
    for (const modelId of ["qwen3.7-text-embedding", "qwen3.7-text-embedding-flash"]) {
      const official = { ...conn, modelId, baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1" };
      expect(embeddingLimits(official)).toEqual({ batchSize: 20, timeoutMs: 20_000 });
      expect(embeddingLimits({ ...official, baseUrl: "https://relay.example/compatible-mode/v1" }).batchSize).toBe(32);
      expect(embeddingLimits({ ...official, retrieval: { format: "openai-embedding", path: "/custom" } }).batchSize).toBe(32);
      expect(embeddingLimits({ ...official, modelId: "other-model" }).batchSize).toBe(32);
    }
  });
  it("reports HTTP status without leaking provider error bodies or credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret upstream payload", { status: 401 })));
    await expect(embed(conn, ["a"], new AbortController().signal)).rejects.toMatchObject({ code: "http", status: 401, message: "Retrieval http (401)" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("private endpoint details")));
    await expect(embed(conn, ["a"], new AbortController().signal)).rejects.toMatchObject({ code: "network", message: "Retrieval network" });
  });
  it("rejects cross-model dimensions and computes cosine similarity", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([2, 0], [1, 0])).toBe(1);
    expect(() => cosine([1, 0], [1])).toThrow();
  });
  it("refuses a stale retrieval binding before sending chat traffic", async () => {
    response({});
    await expect(streamCompletion({ ...conn, standard: "openai_compat", messages: [], onChunk: vi.fn() })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("persists retrieval identity and excludes it from conversation pickers", () => {
    const model = { id: "r", retrieval: conn.retrieval } as Model;
    expect(conversationalModels([model])).toEqual([]);
    const statement = modelUpsert(model, "local");
    expect(statement.sql).toContain("retrieval");
    expect(statement.values).toContain(JSON.stringify(conn.retrieval));
    expect(parseRetrievalConfig(JSON.stringify(conn.retrieval))).toEqual(conn.retrieval);
  });
});
