import { beforeEach, expect, it, vi } from "vitest";
import { semanticPrefs, saveSemanticPrefs, retrievalThreshold } from "../semanticPrefs";
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("../../prefs", () => ({ SEMANTIC_LORE_PREFIX: "semantic:", readPref: (k: string) => storage.get(k), writePref: (k: string, v: string) => storage.set(k, v) }));
beforeEach(() => storage.clear());
it("migrates the old threshold into both score domains without writing on read", () => {
  const old = JSON.stringify({ enabled: true, minScore: -0.2 });
  storage.set("semantic:/p", old);
  const prefs = semanticPrefs("/p");
  expect(prefs.cosineMinScore).toBe(-0.2);
  expect(prefs.rerankerMinScore).toBe(-0.2);
  expect(storage.get("semantic:/p")).toBe(old);
  saveSemanticPrefs("/p", { ...prefs, cosineMinScore: 0.8, rerankerMinScore: 3 });
  expect(retrievalThreshold(semanticPrefs("/p"))).toBe(0.8);
  expect(retrievalThreshold({ ...semanticPrefs("/p"), rerankerModelId: "r" })).toBe(3);
});
it("validates domains independently and preserves explicit zero", () => {
  storage.set("semantic:/p", JSON.stringify({ minScore: 0.2, cosineMinScore: 4, rerankerMinScore: 0 }));
  expect(semanticPrefs("/p")).toMatchObject({ cosineMinScore: 1, rerankerMinScore: 0 });
  storage.set("semantic:/p", JSON.stringify({ minScore: 0.2, cosineMinScore: "bad", rerankerMinScore: null }));
  expect(semanticPrefs("/p")).toMatchObject({ cosineMinScore: 0.2, rerankerMinScore: 0.2 });
  expect(retrievalThreshold(semanticPrefs(null))).toBe(0.5);
  expect(retrievalThreshold({ ...semanticPrefs(null), rerankerModelId: "r", rerankerMinScore: Infinity })).toBe(0.5);
});


it("saves defaults without a project and lets unconfigured projects inherit them", () => {
  const defaults = { ...semanticPrefs(null), enabled: true, documentEnabled: true, embeddingModelId: "vectors", rerankerModelId: "rank", cosineMinScore: 0.7, rerankerMinScore: 2 };
  saveSemanticPrefs(null, defaults);
  expect(semanticPrefs(null)).toEqual(defaults);
  expect(semanticPrefs("/new")).toEqual(defaults);
  expect(storage.has("semantic:/new")).toBe(false);
});

it("preserves explicit project opt-out and independent model selections", () => {
  const own = { ...semanticPrefs(null), enabled: false, embeddingModelId: "own" };
  saveSemanticPrefs("/existing", own);
  saveSemanticPrefs(null, { ...semanticPrefs(null), enabled: true, embeddingModelId: "global" });
  expect(semanticPrefs("/existing")).toMatchObject(own);
  saveSemanticPrefs("/new", { ...semanticPrefs("/new"), rerankerModelId: "custom" });
  saveSemanticPrefs(null, { ...semanticPrefs(null), embeddingModelId: "changed" });
  expect(semanticPrefs("/new")).toMatchObject({ embeddingModelId: "global", rerankerModelId: "custom" });
  expect(semanticPrefs("/other").embeddingModelId).toBe("changed");
});

it("does not enable a project with a malformed override through defaults", () => {
  saveSemanticPrefs(null, { ...semanticPrefs(null), enabled: true });
  storage.set("semantic:/broken", "{");
  expect(semanticPrefs("/broken").enabled).toBe(false);
});
