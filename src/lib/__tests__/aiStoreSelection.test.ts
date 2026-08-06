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

const { useAiStore } = await import("../../stores/aiStore");

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
