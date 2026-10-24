import { describe, expect, it } from "vitest";
import type { Model } from "../../../../lib/ai/configDb";
import type { SemanticPrefs } from "../../../../lib/context/semanticPrefs";
import { retrievalDeletionWarning, retrievalModelWarning } from "../retrievalModelWarning";

const embedding: Model = {
  id: "vectors", modelId: "embed-v1", name: "Vectors", providerId: "local", type: "embedding",
  enabled: true, priceIn: 0, priceCachedIn: 0, priceOut: 0,
  retrieval: { format: "openai-embedding", path: "/v1/embeddings" },
};
const prefs: SemanticPrefs = { enabled: false, embeddingModelId: "vectors", rerankerModelId: "rank", minScore: 0.5 };
const empty = { ...prefs, embeddingModelId: "", rerankerModelId: "" };
const ranking: Model = { ...embedding, id: "rank", type: "rerank", retrieval: { format: "cohere-rerank", path: "/v2/rerank" } };

describe("retrieval model mutation warnings", () => {
  it.each([embedding, ranking])("warns for a selected $type even with the project Beta off", (model) => {
    expect(retrievalModelWarning(model, { ...model, type: "text", retrieval: undefined }, prefs)).toBe("current");
    expect(retrievalModelWarning(model, null, prefs)).toBe("current");
    expect(prefs.enabled).toBe(false);
    expect(prefs.embeddingModelId).toBe("vectors");
    expect(prefs.rerankerModelId).toBe("rank");
  });
  it.each<Partial<Model>>([
    { modelId: "embed-v2" }, { providerId: "remote" }, { activeRoute: "responses" },
    { enabled: false }, { type: "rerank", retrieval: ranking.retrieval },
    { retrieval: { ...embedding.retrieval!, path: "/other" } },
    { retrieval: { ...embedding.retrieval!, queryPrefix: "query: " } },
    { retrieval: { ...embedding.retrieval!, documentPrefix: "passage: " } },
  ])("covers retrieval-affecting changes %j", (patch) => {
    expect(retrievalModelWarning(embedding, { ...embedding, ...patch }, prefs)).toBe("current");
    expect(retrievalModelWarning(embedding, { ...embedding, ...patch }, empty)).toBe("other");
  });
  it("does not interrupt a no-op, rename, pricing or conversational-only change", () => {
    expect(retrievalModelWarning(embedding, { ...embedding, name: "New name", feeGroupId: "fee" }, prefs)).toBeNull();
    expect(retrievalModelWarning(embedding, { ...embedding, retrieval: { ...embedding.retrieval! } }, prefs)).toBeNull();
    const chat = { ...embedding, id: "chat", type: "text" as const, retrieval: undefined };
    expect(retrievalModelWarning(chat, { ...chat, modelId: "new-chat" }, prefs)).toBeNull();
    expect(retrievalModelWarning(chat, null, prefs)).toBeNull();
  });
  it("does not mistake unknown projects for verified bindings", () => {
    expect(retrievalModelWarning(embedding, null, empty)).toBe("other");
    expect(retrievalDeletionWarning([embedding, ranking], empty)).toBe("other");
  });
  it("warns about a stale selection even if its model was already retyped", () => {
    expect(retrievalModelWarning({ ...embedding, type: "text", retrieval: undefined }, null, prefs)).toBe("current");
  });
  it("aggregates channel deletion and prioritizes the known active-project binding", () => {
    const unbound = { ...embedding, id: "unbound" };
    expect(retrievalDeletionWarning([unbound, ranking], prefs)).toBe("current");
    expect(retrievalDeletionWarning([unbound], prefs)).toBe("other");
    expect(retrievalDeletionWarning([], prefs)).toBeNull();
  });
});
