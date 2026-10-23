import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentChunks, retrieveDocument } from "../documentRetrieval";
import { embed, rerank } from "../../ai/retrieval";
import { assembleContext, bundleToMessages } from "../rag";
import { documentWindowLimit } from "../documentRetrievalPolicy";
import { planContextBudget } from "../budget";
import type { SemanticRequest } from "../semanticLore";

const state = vi.hoisted(() => ({
  evictAfterWrite: false,
  prefs: { enabled: true, documentEnabled: true, embeddingModelId: "e", rerankerModelId: "r", minScore: 0.5 },
  cache: new Map<string, Map<string, { entry: string; hash: string; vector: number[] }>>(),
}));
vi.mock("../semanticPrefs", () => ({ semanticPrefs: () => state.prefs }));
vi.mock("../embeddingCache", async (original) => ({
  ...await original<typeof import("../embeddingCache")>(),
  documentEmbeddingCache: {
    readEmbeddings: async (_p: string, n: string) => new Map(state.cache.get(n)),
    writeEmbeddings: async (_p: string, n: string, rows: { entry: string; hash: string; vector: number[] }[]) => {
      const stored = state.cache.get(n) ?? new Map(); rows.forEach((r) => stored.set(r.entry, r)); state.cache.set(n, stored);
      if (state.evictAfterWrite) state.cache.clear();
    },
    invalidateEmbeddings: async (_p: string, n: string) => { state.cache.delete(n); },
    pruneNamespace: async (_p: string, n: string, entries: string[]) => {
      for (const key of state.cache.get(n)?.keys() ?? []) if (!entries.includes(key)) state.cache.get(n)?.delete(key);
    },
  },
}));
vi.mock("../semanticIndex", () => ({
  resolveIndexConnection: async (_a: unknown, id: string) => ({
    conn: { baseUrl: "http://local", modelId: id, retrieval: { format: id === "r" ? "cohere-rerank" : "openai-embedding", path: "/v1/embeddings" } },
    usage: vi.fn(),
  }),
  indexIdentity: async (conn: { modelId: string }) => conn.modelId,
}));
vi.mock("../loreSelect", () => ({ selectLore: vi.fn(async () => ({ text: "", report: { entities: [], usedChars: 0, budgetChars: 1000 } })) }));
vi.mock("../../ai/retrieval", async (original) => ({
  ...await original<typeof import("../../ai/retrieval")>(), embed: vi.fn(), rerank: vi.fn(),
}));
const args: SemanticRequest = { projectPath: "/p", models: [], providers: [] };
const manuscript = Array.from({ length: 120 }, (_, i) => `\n\nHeading ${i}\n${String(i).padStart(3, "0")} ${"A fictional historical detail. ".repeat(12)}`).join("");
beforeEach(() => {
  vi.clearAllMocks(); state.cache.clear(); state.evictAfterWrite = false;
  state.prefs = { enabled: true, documentEnabled: true, embeddingModelId: "e", rerankerModelId: "r", minScore: 0.5 };
  vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0]));
  vi.mocked(rerank).mockImplementation(async (_c, _q, texts) => texts.map((_, index) => ({ index, score: 0.9 })));
});
afterEach(() => vi.useRealTimers());

describe("current document retrieval", () => {
  it("bounds chunks for long text without paragraph breaks", () => {
    const text = "x".repeat(12000);
    const chunks = documentChunks(text, text.length);
    expect(chunks[chunks.length - 1]?.to).toBe(text.length);
    expect(chunks.every((chunk) => chunk.text.length <= 1200)).toBe(true);
  });
  it("keeps UTF-16 pairs intact at cuts, overlap starts and a partial anchor", () => {
    const text = "😀𠮷".repeat(4000);
    for (const end of [text.length, 1201, 2403]) {
      const chunks = documentChunks(text, end);
      expect(chunks[chunks.length - 1]?.to).toBe(end - end % 2);
      chunks.forEach((chunk, i) => {
        expect(chunk.from % 2).toBe(0);
        expect(chunk.to % 2).toBe(0);
        expect(chunk.text).toBe(text.slice(chunk.from, chunk.to));
        expect(chunk.text.length).toBeLessThanOrEqual(1200);
        if (i) expect([159, 160]).toContain(chunks[i - 1].to - chunk.from);
      });
    }
  });
  it("splits bounded overlapping excerpts with accurate source offsets and never crosses the anchor", () => {
    const text = manuscript + "FUTURE_SECRET";
    const chunks = documentChunks(text, manuscript.length);
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunks[0].from).toBe(0);
    expect(chunks[chunks.length - 1]?.to).toBe(manuscript.length);
    chunks.forEach((c) => {
      expect(c.text).toBe(text.slice(c.from, c.to));
      expect(c.text.length).toBeLessThanOrEqual(1202);
      expect(c.text).not.toContain("FUTURE_SECRET");
    });
  });
  it("indexes the editor snapshot, reranks a shortlist and keeps local context within the budget", async () => {
    const result = await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "find a historical detail");
    expect(result.report?.status).toBe("complete");
    expect(result.local).toBe(manuscript.slice(-6000).trim());
    expect(vi.mocked(rerank).mock.calls[0][2]).toHaveLength(30);
    expect(result.excerpts.length).toBeGreaterThan(0);
    expect(result.excerpts.length).toBeLessThanOrEqual(6);
    expect(result.excerpts.reduce((n, c) => n + c.text.length + 100, result.local.length + 600)).toBeLessThanOrEqual(16000);
    expect(result.excerpts.every((c) => c.to <= manuscript.length - 6000)).toBe(true);
    expect(result.excerpts.map((c) => c.from)).toEqual(result.excerpts.map((c) => c.from).sort((a, b) => a - b));
  });
  it("reuses unchanged chunk vectors but refreshes the query and reranking each execution", async () => {
    await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "first question");
    vi.mocked(embed).mockClear();
    await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "second question");
    expect(embed).toHaveBeenCalledTimes(1);
    expect(vi.mocked(embed).mock.calls[0][1]).toEqual(["second question"]);
    expect(rerank).toHaveBeenCalledTimes(2);
  });
  it("only re-encodes changed chunks and isolates documents and models", async () => {
    await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "query");
    vi.mocked(embed).mockClear();
    const changed = manuscript.replace("Heading 2\n", "EDITED 2!\n");
    await retrieveDocument(args, "draft.md", changed, changed.length, 16000, "query");
    const encoded = vi.mocked(embed).mock.calls.flatMap((c) => c[1]).filter((t) => t !== "query");
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded.length).toBeLessThan(5);
    vi.mocked(embed).mockClear();
    await retrieveDocument(args, "other.md", manuscript, manuscript.length, 16000, "query");
    expect(vi.mocked(embed).mock.calls.flatMap((c) => c[1]).length).toBeGreaterThan(20);
  });
  it("does not send prose after a mid-document edit or duplicate its local window", async () => {
    const text = manuscript + "NEVER_SEND_AFTER_ANCHOR";
    await retrieveDocument(args, "draft.md", text, manuscript.length, 16000, "query");
    expect(vi.mocked(embed).mock.calls.flatMap((c) => c[1]).join("\n")).not.toContain("NEVER_SEND_AFTER_ANCHOR");
  });
  it("supports embedding-only retrieval and applies the relevance threshold", async () => {
    state.prefs.rerankerModelId = "";
    vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map((t) => t === "query" ? [-1, 0] : [1, 0]));
    const result = await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "query");
    expect(result.report?.status).toBe("complete"); expect(result.excerpts).toEqual([]);
    expect(result.local).toBe(manuscript.slice(-16000).trim());
    expect(rerank).not.toHaveBeenCalled();
  });
  it("reports an unavailable embedding model without silently sending all prose", async () => {
    state.prefs.embeddingModelId = "";
    const result = await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "query");
    expect(result.report?.status).toBe("unavailable"); expect(result.local).toBe(manuscript.slice(-16000).trim());
    expect(embed).not.toHaveBeenCalled();
  });
  it("times out even when a transport ignores cancellation", async () => {
    vi.useFakeTimers(); vi.mocked(embed).mockImplementation(() => new Promise(() => {}));
    const pending = retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "query");
    await vi.advanceTimersByTimeAsync(60001);
    const result = await pending;
    expect(result.report?.status).toBe("timeout");
    expect(result.local).toBe(manuscript.slice(-16000).trim());
    vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map(() => [1, 0]));
    expect((await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "retry")).report?.status).toBe("complete");
  });
  it("propagates the author's cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(retrieveDocument({ ...args, signal: controller.signal }, "draft.md", manuscript, manuscript.length, 16000, "query")).rejects.toThrow();
    expect(embed).not.toHaveBeenCalled();
  });
  it("skips paid indexing when the reference window is disabled or already small", async () => {
    await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 2000, "query");
    expect(embed).not.toHaveBeenCalled();
  });
  it("preserves full rewrite/summary selections and excludes later prose during assembly", async () => {
    const selection = "Full edit target. ".repeat(2000);
    const text = manuscript + selection + "FUTURE_SECRET";
    const bundle = await assembleContext("system", {}, text, selection, "Summarize this selection", {
      documentFile: "draft.md", semantic: args, contextChars: 900000,
    }, { from: manuscript.length, to: manuscript.length + selection.length });
    const wire = bundleToMessages(bundle)[1].content;
    expect(wire).toContain(selection); expect(wire).not.toContain("FUTURE_SECRET");
    expect(bundle.recentContext.length).toBeLessThanOrEqual(6000);
    expect(bundle.documentExcerpts).toBeTruthy(); expect(bundle.loreReport.documentRetrieval?.status).toBe("complete");
  });
  it("leaves existing document injection unchanged when the project opt-in is off", async () => {
    state.prefs.documentEnabled = false;
    const bundle = await assembleContext("system", {}, manuscript, "", "Continue", {
      documentFile: "draft.md", semantic: args, contextChars: 900000,
    });
    expect(bundle.recentContext).toBe(manuscript.trim()); expect(embed).not.toHaveBeenCalled();
    expect(bundle.documentExcerpts).toBeUndefined();
  });
  it("caps dynamic and explicit background windows without changing selection costs", () => {
    expect(documentWindowLimit(state.prefs)).toBe(16000);
    const input = { contextSize: 1000000, maxOutputTokens: 2000, utilization: 0.8, loreBudgetTokens: 1000,
      fixedChars: 30000, availableRecentChars: 900000, hasMemory: false, includeBookContext: false,
      recentWindowLimitChars: 16000 };
    expect(planContextBudget(input).recentWindowChars).toBeLessThanOrEqual(16000);
    expect(planContextBudget({ ...input, recentWindowChars: 900000 }).recentWindowChars).toBe(16000);
    expect(planContextBudget({ ...input, recentWindowChars: 0 }).recentWindowChars).toBe(0);
  });
});


it("bounds an oversized catalog explicitly instead of silently indexing a prefix", async () => {
  const text = "x".repeat(4_500_000);
  const result = await retrieveDocument(args, "huge.md", text, text.length, 16000, "query");
  expect(result.report?.status).toBe("tooLarge");
  expect(result.report?.considered).toBe(4097);
  expect(result.local).toBe(text.slice(-16000));
  expect(embed).not.toHaveBeenCalled();
});

it("invalidates a changed vector dimension instead of mixing vector spaces", async () => {
  await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "query");
  vi.mocked(embed).mockResolvedValue([[1, 0, 0]]);
  const result = await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "query");
  expect(result.report?.status).toBe("unavailable");
  expect(state.cache.size).toBe(0);
  expect(result.local).toBe(manuscript.slice(-16000).trim());
});


it("lets reranking recover a low-cosine passage before applying the final score threshold", async () => {
  const text = "The healer keeps a hidden antidote.\n\n" + "Unrelated travel accounts. ".repeat(800);
  vi.mocked(embed).mockImplementation(async (_c, texts) => texts.map((t) =>
    t.includes("hidden antidote") ? [0.1, 0.995] : [1, 0]));
  vi.mocked(rerank).mockImplementation(async (_c, _q, texts) => texts.map((t, index) => ({
    index, score: t.includes("hidden antidote") ? 0.95 : 0.1,
  })).sort((a, b) => b.score - a.score));
  const result = await retrieveDocument(args, "draft.md", text, text.length, 16000, "Who can cure snake venom?");
  expect(result.excerpts).toHaveLength(1);
  expect(result.excerpts[0].text).toContain("hidden antidote");
  expect(result.report?.matches[0].score).toBe(0.95);
});


it.each([0, 2000, 8000, 16000])("bounds failure fallback to %i chars before a mid-document anchor", async (budget) => {
  state.prefs.embeddingModelId = "";
  const end = 20000;
  const result = await retrieveDocument(args, "draft.md", manuscript.slice(0, end) + "FUTURE_SECRET", end, budget, "query");
  expect(result.local).toBe(manuscript.slice(end - budget, end).trim());
  expect(result.excerpts).toEqual([]);
  expect(result.local).not.toContain("FUTURE_SECRET");
});

it("uses the task's preference snapshot even if settings change before assembly", async () => {
  const prefs = { ...state.prefs, documentEnabled: false };
  const bundle = await assembleContext("system", {}, manuscript, "", "Continue", {
    documentFile: "draft.md", semantic: { ...args, prefs }, contextChars: 20000,
  });
  expect(bundle.recentContext).toBe(manuscript.slice(-20000).trim());
  expect(embed).not.toHaveBeenCalled();
});


it("finishes an in-flight retrieval even if cache pressure evicts every completed batch", async () => {
  state.evictAfterWrite = true;
  const result = await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "query");
  expect(result.report?.status).toBe("complete");
  expect(result.excerpts.length).toBeGreaterThan(0);
  expect(state.cache.size).toBe(0);
  const encoded = vi.mocked(embed).mock.calls.flatMap((call) => call[1]).filter((text) => text !== "query");
  expect(encoded).toHaveLength(new Set(encoded).size);
  expect(result.excerpts.every((chunk) => chunk.to <= manuscript.length - 6000)).toBe(true);
});


it.each(["insert", "delete"])("reuses most paid chunk inputs after an early %s", async (edit) => {
  await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "query");
  const original = new Set(vi.mocked(embed).mock.calls.flatMap((c) => c[1]).filter((t) => t !== "query"));
  vi.mocked(embed).mockClear();
  const changed = edit === "insert"
    ? manuscript.slice(0, 57) + "An inserted early paragraph.\n\n" + manuscript.slice(57)
    : manuscript.slice(0, 57) + manuscript.slice(130);
  const result = await retrieveDocument(args, "draft.md", changed, changed.length, 16000, "query");
  const encoded = vi.mocked(embed).mock.calls.flatMap((c) => c[1]).filter((t) => t !== "query");
  expect(result.report?.status).toBe("complete");
  expect(encoded.length).toBeGreaterThan(0);
  expect(encoded.length / original.size).toBeLessThan(0.15);
  expect(encoded.every((t) => !original.has(t))).toBe(true);
  expect(result.excerpts.every((c) => c.text === changed.slice(c.from, c.to))).toBe(true);
});

it.each(["\n\n", " "])("resynchronizes content boundaries in varied prose with separator %j", (separator) => {
  let seed = 12345;
  const text = Array.from({ length: 1000 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return `${i}: The traveller recorded ${seed.toString(36)} beside the river. 中文😀`;
  }).join(separator);
  const original = documentChunks(text, text.length);
  const known = new Set(original.map((c) => c.text));
  for (const position of [0, 57, 1020, 2500]) {
    const changed = text.slice(0, position) + "A new observation.\n\n" + text.slice(position);
    const chunks = documentChunks(changed, changed.length);
    expect(chunks.filter((c) => known.has(c.text)).length / chunks.length).toBeGreaterThan(0.9);
    expect(chunks).toEqual(documentChunks(changed + "FUTURE_SECRET", changed.length));
    chunks.forEach((chunk, i) => {
      expect(chunk.text).toBe(changed.slice(chunk.from, chunk.to));
      expect(chunk.text.length).toBeLessThanOrEqual(1200);
      if (i) expect([159, 160]).toContain(chunks[i - 1].to - chunk.from);
    });
  }
});

it("isolates the new chunk algorithm from legacy namespaces", async () => {
  const { digest } = await import("../embeddingCache");
  const legacy = await digest(JSON.stringify(["document-v1", "draft.md", "e"]));
  state.cache.set(legacy, new Map());
  await retrieveDocument(args, "draft.md", manuscript, manuscript.length, 16000, "query");
  const current = await digest(JSON.stringify(["document-cdc-v2", "draft.md", "e"]));
  expect(state.cache.get(legacy)?.size).toBe(0);
  expect(state.cache.get(current)?.size).toBeGreaterThan(0);
});
