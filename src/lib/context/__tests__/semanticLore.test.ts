import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSemanticCache, retrieveSemantic, catalogText, type SemanticRequest } from "../semanticLore";
import { saveSemanticPrefs, semanticPrefs } from "../semanticPrefs";
import { assembleContext } from "../rag";
import { selectLore } from "../loreSelect";
import { embed, rerank, RetrievalError } from "../../ai/retrieval";
import type { LoreEntity, LoreIndex } from "../../lore";
import type { Model, Provider } from "../../ai/configDb";

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
const enable = (embeddingModelId = "", rerankerModelId = "r") => saveSemanticPrefs("/p", { enabled: true, embeddingModelId, rerankerModelId, minScore: 0.5 });
beforeEach(() => { prefs.clear(); clearSemanticCache(); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

describe("semantic catalog retrieval", () => {
  it("is off by default and isolated per project", async () => {
    expect(semanticPrefs("/p").enabled).toBe(false);
    expect(await retrieveSemantic("sneak inside", index, null, new Set(), args)).toEqual({ matches: [] });
    enable(); expect(semanticPrefs("/other").enabled).toBe(false);
    expect(rerank).not.toHaveBeenCalled();
  });
  it("discovers an unnamed entry without sending out-of-scope descriptions", async () => {
    enable(); vi.mocked(rerank).mockResolvedValue([{ index: 0, score: 0.9 }]);
    const result = await retrieveSemantic("sneak inside", index, ["wanted"], new Set(), args);
    expect(result.matches.map((m) => m.entity.name)).toEqual(["Compass"]);
    expect(vi.mocked(rerank).mock.calls[0][2]).toEqual([catalogText(index.custom[0])]);
  });
  it("reuses vectors but invalidates changed descriptions and keeps query requests fresh", async () => {
    enable("e", ""); vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0]));
    await retrieveSemantic("sneak", index, ["wanted"], new Set(), args);
    await retrieveSemantic("sneak again", index, ["wanted"], new Set(), args);
    expect(embed).toHaveBeenCalledTimes(3);
    await retrieveSemantic("sneak", { custom: [{ ...index.custom[0], summary: "Changed" }] }, null, new Set(), args);
    expect(embed).toHaveBeenCalledTimes(5);
  });
  it("splits a cold Ark catalog into accepted batches and reuses every vector", async () => {
    enable("e", "");
    const arkArgs = { ...args, providers: [{ id: "p", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3" }] as Provider[] };
    const catalog = { custom: Array.from({ length: 32 }, (_, i) => entity(`entry-${i}`)) };
    vi.mocked(embed).mockImplementation(async (_c, texts) => {
      if (texts.length > 10) throw new RetrievalError("http", 400);
      return texts.map(() => [1, 0]);
    });
    const first = await retrieveSemantic("sneak", catalog, null, new Set(), arkArgs);
    expect(first.report).toMatchObject({ status: "complete", considered: 32 });
    expect(first.matches).toHaveLength(5);
    expect(vi.mocked(embed).mock.calls.map((c) => c[1].length)).toEqual([10, 10, 10, 2, 1]);
    expect(vi.mocked(embed).mock.calls.slice(0, 4).flatMap((c) => c[1])).toEqual(
      [...catalog.custom].sort((a, b) => a.dirPath.localeCompare(b.dirPath)).map(catalogText),
    );
    await retrieveSemantic("again", catalog, null, new Set(), arkArgs);
    expect(embed).toHaveBeenCalledTimes(6);
  });
  it("allows Ark cold batches past 20 seconds but still stops at the absolute deadline", async () => {
    vi.useFakeTimers(); enable("e", "");
    const arkArgs = { ...args, providers: [{ id: "p", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3" }] as Provider[] };
    vi.mocked(embed).mockImplementation(async (_c, texts) => {
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      return texts.map(() => [1, 0]);
    });
    const pending = retrieveSemantic("sneak", index, null, new Set(), arkArgs);
    await vi.advanceTimersByTimeAsync(22_001);
    expect((await pending).report?.status).toBe("complete");
    vi.mocked(embed).mockImplementation(() => new Promise(() => {}));
    const stalled = retrieveSemantic("again", index, null, new Set(), arkArgs);
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await stalled).report?.status).toBe("timeout");
  });
  it("invalidates cached vectors if the served model changes dimensions", async () => {
    enable("e", "");
    vi.mocked(embed).mockResolvedValueOnce([[1, 0]]).mockResolvedValueOnce([[1, 0, 0]]);
    expect((await retrieveSemantic("sneak", index, ["wanted"], new Set(), args)).report?.status).toBe("unavailable");
    vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0, 0]));
    expect((await retrieveSemantic("sneak", index, ["wanted"], new Set(), args)).matches).toHaveLength(1);
    expect(embed).toHaveBeenCalledTimes(4);
  });
  it("uses reranking as the final score and allows zero matches", async () => {
    enable("e", "r"); vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0]));
    vi.mocked(rerank).mockResolvedValue([{ index: 0, score: 0.1 }]);
    expect((await retrieveSemantic("sneak", index, null, new Set(), args)).matches).toEqual([]);
  });
  it("falls back visibly on unavailable models and malformed services", async () => {
    enable("missing", "");
    expect((await retrieveSemantic("sneak", index, null, new Set(), args)).report?.status).toBe("unavailable");
    enable(); vi.mocked(rerank).mockRejectedValue(new Error("down"));
    expect((await retrieveSemantic("sneak", index, null, new Set(), args)).report?.status).toBe("unavailable");
  });
  it("does not duplicate author text in first-turn semantic queries", async () => {
    enable("e", ""); vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0]));
    const question = "x".repeat(2500);
    const bundle = await assembleContext("system", index, "", "", "task", { extraMatchText: question, semantic: args });
    expect(bundle.loreReport.semantic?.queryTruncated).toBe(false);
    expect(vi.mocked(embed).mock.calls[vi.mocked(embed).mock.calls.length - 1]?.[1]).toEqual([question + "\n"]);
  });
  it("preserves actionable failure details without serializing raw errors", async () => {
    enable(); vi.mocked(rerank).mockRejectedValue(new RetrievalError("http", 404));
    const { report } = await retrieveSemantic("sneak", index, null, new Set(), args);
    expect(report).toMatchObject({ status: "unavailable", failure: { code: "http", status: 404 } });
  });
  it("bounds even a service that ignores cancellation", async () => {
    vi.useFakeTimers(); enable(); vi.mocked(rerank).mockImplementation(() => new Promise(() => {}));
    const pending = retrieveSemantic("sneak", index, null, new Set(), args);
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await pending).report?.status).toBe("timeout");
  });
  it("propagates the author's cancellation instead of continuing the writing request", async () => {
    enable(); const controller = new AbortController(); controller.abort();
    await expect(retrieveSemantic("sneak", index, null, new Set(), { ...args, signal: controller.signal })).rejects.toThrow();
    expect(rerank).not.toHaveBeenCalled();
  });
  it("cannot evict explicit matches or exceed the remaining budget", async () => {
    enable(); vi.mocked(rerank).mockResolvedValue([{ index: 0, score: 0.9 }]);
    const ordinary = await selectLore("Compass", index, [], 60);
    const semantic = await selectLore("Compass", index, [], 60, { semantic: args });
    expect(semantic.text).toBe(ordinary.text);
    expect(semantic.report.semantic?.budgetDropped).toBe(1);
    expect(semantic.report.usedChars).toBe(ordinary.report.usedChars);
  });
  it("reports semantic provenance when the entry fits", async () => {
    enable(); vi.mocked(rerank).mockResolvedValue([{ index: 0, score: 0.9 }]);
    const result = await selectLore("sneak", index, [], 1000, { semantic: args, scope: ["wanted"] });
    expect(result.text).toContain("Compass");
    expect(result.report.entities[0]).toMatchObject({ reason: "semantic", semanticScore: 0.9 });
  });
});
