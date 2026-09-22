/**
 * A restored configuration's model picks must reach the running store, and must
 * not be overwritten by the picks this window was holding before the restore.
 *
 * The store reads selections from prefs once, at module scope. A restore writes
 * new ones into prefs, then `loadConfig` sweeps stale ids — and that sweep used
 * to hand every subagent binding a fresh object, which the persistence
 * subscription (comparing by reference) took as a change and wrote back: the
 * window's *old* bindings, over the restored ones.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
// `loadConfig` is a no-op outside Tauri; the store decides that at import.
vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });

const models = [{ id: "old" }, { id: "restored" }, { id: "other" }];
vi.mock("../../lib/project", () => ({
  // 计费组和 providers / models 同一个库：`loadConfig` 现在也读 `fee_groups`。
  getGlobalDb: async () => ({ select: async () => [] }),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../../lib/keyStore", () => ({
  migrateLegacyKeys: async () => ({ migrated: 0 }),
  saveApiKey: async () => {},
  loadApiKey: async () => null,
  deleteApiKey: async () => {},
}));
vi.mock("../../lib/ai/configDb", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ai/configDb")>("../../lib/ai/configDb");
  return {
    ...actual,
    ensureAiSchema: async () => {},
    listProviders: async () => [],
    listModels: async () => models,
    listPrompts: async () => [],
  };
});

const { useAiStore } = await import("../aiStore");

beforeEach(() => {
  store.clear();
  const s = useAiStore.getState();
  useAiStore.setState({
    activeModelId: "old",
    subAgents: { ...s.subAgents, writer: { kind: "writer", modelId: "old", enabled: false } },
  });
  store.clear();
});

/** What a restore leaves in prefs: another machine's picks. */
function restorePrefs() {
  store.set("ai:activeModelId", "restored");
  store.set("ai:subagent:writer:modelId", "restored");
  store.set("ai:subagent:writer:enabled", "true");
}

describe("after a config restore", () => {
  it("loadConfig leaves a still-valid subagent binding's prefs alone", async () => {
    restorePrefs();
    await useAiStore.getState().loadConfig();
    expect(store.get("ai:subagent:writer:modelId")).toBe("restored");
    expect(store.get("ai:subagent:writer:enabled")).toBe("true");
  });

  it("reloadSelections then loadConfig adopts the restored picks", async () => {
    restorePrefs();
    useAiStore.getState().reloadSelections();
    await useAiStore.getState().loadConfig();

    const s = useAiStore.getState();
    expect(s.activeModelId).toBe("restored");
    expect(s.subAgents.writer).toMatchObject({ modelId: "restored", enabled: true });
    expect(store.get("ai:subagent:writer:modelId")).toBe("restored");
  });

  it("still clears a restored pick that points at no model here", async () => {
    store.set("ai:subagent:writer:modelId", "gone");
    useAiStore.getState().reloadSelections();
    await useAiStore.getState().loadConfig();

    expect(useAiStore.getState().subAgents.writer.modelId).toBeNull();
    expect(store.has("ai:subagent:writer:modelId")).toBe(false);
  });
});
