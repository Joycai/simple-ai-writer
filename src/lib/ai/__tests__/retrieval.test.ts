import { afterEach, describe, expect, it, vi } from "vitest";
import { embed, rerank, retrievalUrl, cosine, type RetrievalConnection } from "../retrieval";
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
  it("never forwards a channel key to a model-supplied host", () => {
    for (const path of ["https://evil.test/rerank", "//evil.test/rerank", "/\\evil.test/rerank", "/x?key=a"]) {
      expect(parseRetrievalConfig({ format: "cohere-rerank", path })).toBeUndefined();
      expect(() => retrievalUrl({ ...conn, retrieval: { format: "cohere-rerank", path } })).toThrow();
    }
    expect(retrievalUrl(conn)).toBe("http://localhost:11434/v1/embeddings");
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
