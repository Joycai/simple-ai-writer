/**
 * Model selections must survive a restart.
 *
 * They used to live in memory only, so every launch reset the chat model to
 * whichever model happened to be first in the list — an author who had picked
 * a specific one silently got a different model on the next run.
 *
 * The other half of the guarantee is that a *stale* selection is dropped: an
 * id restored from a previous launch can point at a model that has since been
 * deleted, or come from a config imported off another machine where none of
 * the ids match.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The store module reads localStorage at import time; vitest's node
// environment has none, so stand one up before importing it.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { useAiStore } = await import("../aiStore");

beforeEach(() => {
  store.clear();
  useAiStore.setState({
    providers: [], models: [], prompts: [],
    activeModelId: null, activePromptId: null, memoryModelId: null, imageModelId: null,
  });
});

describe("selection persistence", () => {
  it("writes every selection to localStorage as it changes", () => {
    useAiStore.getState().setActiveModel("m1");
    useAiStore.getState().setMemoryModel("m2");
    useAiStore.getState().setImageModel("m3");
    useAiStore.getState().setActivePrompt("p1");

    expect(store.get("ai:activeModelId")).toBe("m1");
    expect(store.get("ai:memoryModelId")).toBe("m2");
    expect(store.get("ai:imageModelId")).toBe("m3");
    expect(store.get("ai:activePromptId")).toBe("p1");
  });

  it("clears the stored value when a selection is cleared", () => {
    useAiStore.getState().setImageModel("m3");
    useAiStore.getState().setImageModel(null);
    expect(store.has("ai:imageModelId")).toBe(false);
  });

  it("persists a pointer cleared by deleting its model", () => {
    // removeModel writes state directly rather than going through a setter —
    // the subscription is what keeps that path from leaving a stale id behind.
    useAiStore.setState({
      models: [{ id: "m1" }, { id: "m2" }] as never,
      activeModelId: "m1",
      imageModelId: "m1",
    });
    store.set("ai:activeModelId", "m1");
    store.set("ai:imageModelId", "m1");

    useAiStore.setState({
      models: [{ id: "m2" }] as never,
      activeModelId: null,
      imageModelId: null,
    });

    expect(store.has("ai:activeModelId")).toBe(false);
    expect(store.has("ai:imageModelId")).toBe(false);
  });
});

describe("automatic chat-model pick", () => {
  const row = (id: string, type: string) => ({
    providerId: "p", modelId: id, name: id, type, priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true,
  }) as never;

  it("never makes an image or video model the chat model on first add", async () => {
    // 火山方舟 pay-as-you-go's starter list is Seedream only.
    await useAiStore.getState().addModel(row("doubao-seedream-5-0-lite-260128", "image"));
    await useAiStore.getState().addModel(row("some-video", "video"));
    expect(useAiStore.getState().activeModelId).toBeNull();
    await useAiStore.getState().addModel(row("doubao-seed-2.0-lite", "multimodal"));
    const active = useAiStore.getState().models.find((m) => m.id === useAiStore.getState().activeModelId);
    expect(active?.modelId).toBe("doubao-seed-2.0-lite");
  });

  it("drops the chat and summary pick when that model is retyped as image", async () => {
    await useAiStore.getState().addModel(row("nano-banana", "text"));
    await useAiStore.getState().addModel(row("gemini-flash", "text"));
    const [banana, flash] = useAiStore.getState().models;
    expect(useAiStore.getState().activeModelId).toBe(banana.id);
    useAiStore.getState().setMemoryModel(banana.id);

    await useAiStore.getState().updateModel({ ...banana, type: "image" });
    expect(useAiStore.getState().activeModelId).toBe(flash.id);
    expect(useAiStore.getState().memoryModelId).toBeNull();
  });
});

