/**
 * Saving a model row is where a changed structured-output declaration meets
 * the learned store (LLD §9.13): the save must forget that route's ceiling, so
 * the tier the author just picked gets one more try instead of a week under
 * the old refusal. The rules themselves are `learnedForget.test.ts`'s; this
 * holds only that `updateModel` applies them, against the row as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store module reads localStorage at import time; vitest's node
// environment has none, so stand one up before importing it.
const prefs = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => prefs.get(k) ?? null,
  setItem: (k: string, v: string) => void prefs.set(k, v),
  removeItem: (k: string) => void prefs.delete(k),
});

const { useAiStore } = await import("../aiStore");
const { __resetLearned, learnedCeiling, noteLearned } = await import("../../lib/ai/capability/learned");
const { connOptions } = await import("../../lib/ai/conn");
type Model = import("../../lib/ai/configDb").Model;
type Provider = import("../../lib/ai/configDb").Provider;

const channel: Provider = {
  id: "p1", name: "Relay", baseUrl: "https://relay.example/v1", apiStandard: "openai_compat", platform: "newapi",
  createdAt: 0,
};
const model: Model = {
  id: "m1", providerId: "p1", modelId: "qwen3.8-max", name: "Q", type: "text",
  priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, structuredOutput: "json_schema",
};
const key = () => {
  const c = connOptions({ provider: channel, model, apiKey: "k" });
  return { standard: c.standard, baseUrl: c.baseUrl, modelId: c.modelId };
};

beforeEach(() => {
  prefs.clear();
  useAiStore.setState({ providers: [channel], models: [model] });
});
afterEach(() => __resetLearned());

describe("updateModel and the learned store", () => {
  it("forgets the structured-output ceiling when the declaration changes", async () => {
    noteLearned(key(), "structuredOutput", "json_object");
    await useAiStore.getState().updateModel({ ...model, structuredOutput: "json_schema" });
    expect(learnedCeiling(key(), "structuredOutput")).toBe("json_object");

    await useAiStore.getState().updateModel({ ...model, structuredOutput: "off" });
    expect(learnedCeiling(key(), "structuredOutput")).toBeUndefined();
  });
});
