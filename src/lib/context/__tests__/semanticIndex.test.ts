import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareIndex, indexStatus } from "../semanticIndex";
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
