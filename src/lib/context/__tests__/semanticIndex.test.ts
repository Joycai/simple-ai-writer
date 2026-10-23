import { recordUsage } from "../../ai/usageRow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareIndex, indexStatus, resolveIndexConnection, indexIdentity } from "../semanticIndex";
import type { SemanticRequest } from "../semanticLore";
import { embed } from "../../ai/retrieval";
import type { LoreEntity, LoreIndex } from "../../lore";
import type { Model, Provider } from "../../ai/configDb";

const cache = vi.hoisted(() => new Map<string, Map<string, { entry: string; hash: string; vector: number[] }>>());
vi.mock("../embeddingCache", () => ({
  digest: async (s: string) => s,
  readEmbeddings: async (p: string, n: string) => new Map(cache.get(p + n)),
  writeEmbeddings: async (p: string, n: string, rows: { entry: string; hash: string; vector: number[] }[]) => {
    const map = cache.get(p + n) ?? new Map(); rows.forEach((r) => map.set(r.entry, r)); cache.set(p + n, map);
  },
  invalidateEmbeddings: async (p: string, n: string) => { cache.delete(p + n); },
  pruneEmbeddings: async () => {},
  removeEmbeddings: async (p: string, n: string, entries: string[]) => { entries.forEach((e) => cache.get(p + n)?.delete(e)); },
}));
const prefs = vi.hoisted(() => new Map<string, string>());
vi.mock("../../prefs", () => ({ SEMANTIC_LORE_PREFIX: "lore:semantic:", readPref: (k: string) => prefs.get(k), writePref: (k: string, v: string) => prefs.set(k, v) }));
vi.mock("../../keyStore", () => ({ loadApiKey: vi.fn(async () => "") }));
vi.mock("../../ai/routes", async (original) => ({ ...await original<typeof import("../../ai/routes")>(), providerFor: (_m: Model, ps: Provider[]) => ps[0] }));
vi.mock("../../ai/usageRow", () => ({ recordUsage: vi.fn(async () => {}) }));
vi.mock("../../ai/retrieval", async (original) => ({ ...await original<typeof import("../../ai/retrieval")>(), embed: vi.fn(), rerank: vi.fn() }));
vi.mock("../../fs/fileio", () => ({ readFile: vi.fn(async () => "A short body.") }));
const entity = (name: string, collection = "wanted"): LoreEntity => ({ id: name, name, category: "custom", dirPath: `/p/${name}`, aliases: [], summary: `${name} helps with infiltration`, collections: [collection], facets: [], mdFiles: [], images: [], avatarPath: null });
const index: LoreIndex = { custom: [entity("Compass"), entity("Secret", "outside")] };
const models = [
  { id: "e", enabled: true, retrieval: { format: "openai-embedding", path: "/v1/embeddings" }, modelId: "local-embed" },
  { id: "r", enabled: true, retrieval: { format: "cohere-rerank", path: "/v2/rerank" }, modelId: "rank" },
] as Model[];
const args: SemanticRequest = { projectPath: "/p", models, providers: [{ id: "p", baseUrl: "http://localhost:8000" }] as Provider[] };
beforeEach(() => { prefs.clear(); cache.clear(); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());


describe("index preparation", () => {
  it("prepares only the source scope, reuses saved data and refreshes edited descriptions", async () => {
    vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0]));
    const progress = vi.fn();
    await prepareIndex(args, "e", index, ["wanted"], new AbortController().signal, progress);
    expect(vi.mocked(embed).mock.calls[0][1]).toHaveLength(1);
    expect(vi.mocked(embed).mock.calls[0][1][0]).not.toContain("Secret");
    expect(await indexStatus(args, "e", index, ["wanted"])).toEqual({ ready: 1, total: 1 });
    await prepareIndex(args, "e", index, ["wanted"], new AbortController().signal, progress);
    expect(embed).toHaveBeenCalledTimes(1);
    const changed = { custom: [{ ...index.custom[0], summary: "new description" }, index.custom[1]] };
    expect(await indexStatus(args, "e", changed, ["wanted"])).toEqual({ ready: 0, total: 1 });
    await prepareIndex(args, "e", changed, ["wanted"], new AbortController().signal, progress);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith({ ready: 1, total: 1 });
    const other = { ...args, models: [{ ...models[0], modelId: "new-model" }] };
    expect(await indexStatus(other, "e", changed, ["wanted"])).toEqual({ ready: 0, total: 1 });
  });
  it.each(["dashscope-multimodal-embedding", "openai-embedding"] as const)("prepares a Qwen %s catalog in 20-item batches and reuses its own namespace", async (format) => {
    const native: SemanticRequest = { ...args,
      providers: [{ id: "p", baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1" }] as Provider[],
      models: [{ ...models[0], type: "embedding", modelId: format === "openai-embedding" ? "qwen3.7-text-embedding-flash" : "qwen3-vl-embedding",
        retrieval: { format, path: format === "openai-embedding" ? "/v1/embeddings" : "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding" } }] };
    const all = { custom: Array.from({ length: 41 }, (_, i) => entity(`qwen-item-${i}`)) };
    vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0]));
    await prepareIndex(native, "e", all, null, new AbortController().signal, () => {});
    expect(vi.mocked(embed).mock.calls.map((call) => call[1].length)).toEqual([20, 20, 1]);
    expect(await indexStatus(native, "e", all, null)).toEqual({ ready: 41, total: 41 });
    await prepareIndex(native, "e", all, null, new AbortController().signal, () => {});
    expect(embed).toHaveBeenCalledTimes(3);
    expect(await indexStatus(args, "e", all, null)).toEqual({ ready: 0, total: 41 });
  });
  it("saves completed batches on cancellation and resumes only the missing entries", async () => {
    const all = { custom: Array.from({ length: 40 }, (_, i) => entity(`item-${i}`)) };
    const controller = new AbortController();
    vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0]));
    await expect(prepareIndex(args, "e", all, null, controller.signal, (p) => {
      if (p.ready === 32) controller.abort();
    })).rejects.toThrow();
    expect(await indexStatus(args, "e", all, null)).toEqual({ ready: 32, total: 40 });
    await prepareIndex(args, "e", all, null, new AbortController().signal, () => {});
    expect(vi.mocked(embed).mock.calls.map((c) => c[1].length)).toEqual([32, 8]);
  });
  it("serializes concurrent preparation, while an explicit rebuild regenerates saved entries", async () => {
    vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0]));
    await Promise.all([1, 2].map(() => prepareIndex(args, "e", index, null, new AbortController().signal, () => {})));
    expect(embed).toHaveBeenCalledTimes(1);
    await prepareIndex(args, "e", index, null, new AbortController().signal, () => {}, true);
    expect(embed).toHaveBeenCalledTimes(2);
  });
  it("resumes an interrupted rebuild without accepting the old unfinished rows", async () => {
    const all = { custom: Array.from({ length: 40 }, (_, i) => entity(`item-${i}`)) };
    vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0]));
    await prepareIndex(args, "e", all, null, new AbortController().signal, () => {});
    const controller = new AbortController();
    await expect(prepareIndex(args, "e", all, null, controller.signal, (p) => {
      if (p.ready === 32) controller.abort();
    }, true)).rejects.toThrow();
    expect(await indexStatus(args, "e", all, null)).toEqual({ ready: 32, total: 40 });
    await prepareIndex(args, "e", all, null, new AbortController().signal, () => {});
    expect(vi.mocked(embed).mock.calls.map((c) => c[1].length)).toEqual([32, 8, 32, 8]);
  });
  it("stops even if the service ignores cancellation", async () => {
    vi.useFakeTimers();
    vi.mocked(embed).mockImplementation(() => new Promise(() => {}));
    const result = prepareIndex(args, "e", index, null, new AbortController().signal, () => {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await result).toBeInstanceOf(Error);
  });
});


it("records document retrieval usage with the selected model in the existing ledger", async () => {
  const conn = await resolveIndexConnection(args, "e", new AbortController().signal, false, "document");
  conn.usage({ promptTokens: 123 });
  expect(recordUsage).toHaveBeenCalledWith("/p", expect.objectContaining({
    model: models[0], task: "document-embedding", promptTokens: 123,
  }));
  const rank = await resolveIndexConnection(args, "r", new AbortController().signal, true, "document");
  rank.usage({ promptTokens: 45 });
  expect(recordUsage).toHaveBeenCalledWith("/p", expect.objectContaining({
    model: models[1], task: "document-rerank", promptTokens: 45,
  }));
});


it("isolates every editable retrieval protocol field in the cache identity", async () => {
  const conn = { baseUrl: "http://localhost:8000", modelId: "embed", apiKey: "",
    retrieval: { format: "openai-embedding" as const, path: "/v1/embeddings", queryPrefix: "query: ", documentPrefix: "doc: " } };
  const original = await indexIdentity(conn);
  for (const change of [{ format: "dashscope-multimodal-embedding" as const }, { path: "/other" },
    { queryPrefix: "question: " }, { documentPrefix: "passage: " }]) {
    expect(await indexIdentity({ ...conn, retrieval: { ...conn.retrieval, ...change } })).not.toBe(original);
  }
  expect(await indexIdentity({ ...conn, apiKey: "rotated" })).toBe(original);
});
