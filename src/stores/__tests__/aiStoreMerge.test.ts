/**
 * `mergeProviders` — the one operation that deletes model ids (plan §5.3,
 * invariant 1). Pinned: the rows go in **one** transaction, every selection
 * that named a merged-away id follows it to the kept row, the open project's
 * usage rows are re-pointed, and the absorbed key is removed only **after**
 * the database stopped referring to it.
 */
import { describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });

const order: string[] = [];
const h = vi.hoisted(() => ({
  tx: vi.fn(),
  remap: vi.fn(),
  delKey: vi.fn(),
}));
vi.mock("../../lib/project", () => ({
  getGlobalDb: async () => ({}),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../../lib/sqlTx", () => ({
  sqlTransaction: async (...a: unknown[]) => { order.push("tx"); h.tx(...a); },
}));
vi.mock("../../lib/ai/usage", async () => ({
  ...(await vi.importActual<typeof import("../../lib/ai/usage")>("../../lib/ai/usage")),
  remapUsageModelIds: async (...a: unknown[]) => { order.push("usage"); h.remap(...a); },
}));
vi.mock("../../lib/keyStore", () => ({
  migrateLegacyKeys: async () => ({ migrated: 0 }),
  saveApiKey: async () => {},
  loadApiKey: async () => "sk-1",
  deleteApiKey: async (id: string) => { order.push("key"); h.delKey(id); },
}));
vi.mock("../../lib/ai/configDb", async () => ({
  ...(await vi.importActual<typeof import("../../lib/ai/configDb")>("../../lib/ai/configDb")),
  ensureAiSchema: async () => {},
}));

const { useAiStore } = await import("../aiStore");
const { normalizeChannel } = await import("../../lib/ai/routes");

describe("mergeProviders", () => {
  it("folds, re-points every reference, and removes the key last", async () => {
    const keep = normalizeChannel({ id: "mm", name: "MiniMax", baseUrl: "https://api.minimaxi.com", apiStandard: "openai_compat", createdAt: 0 });
    const absorb = normalizeChannel({ id: "mmc", name: "MiniMax (Claude)", baseUrl: "https://api.minimaxi.com/anthropic", apiStandard: "anthropic_compat", createdAt: 1 });
    const base = { type: "text" as const, priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true };
    const s = useAiStore.getState();
    useAiStore.setState({
      providers: [keep, absorb],
      models: [
        { ...base, id: "a1", providerId: "mm", modelId: "MiniMax-M3", name: "M3" },
        { ...base, id: "b1", providerId: "mmc", modelId: "MiniMax-M3", name: "M3 (Claude)", temperature: 1 },
      ],
      activeModelId: "b1",
      subAgents: { ...s.subAgents, writer: { kind: "writer", modelId: "b1", enabled: true } },
    });

    await useAiStore.getState().mergeProviders("mm", "mmc", "/proj");

    const after = useAiStore.getState();
    expect(h.tx).toHaveBeenCalledTimes(1);
    expect(after.providers.map((p) => p.id)).toEqual(["mm"]);
    expect(after.models.map((m) => m.id)).toEqual(["a1"]);
    expect(after.models[0].routes?.anthropic).toEqual({ temperature: 1 });
    expect(after.activeModelId).toBe("a1");
    expect(after.subAgents.writer.modelId).toBe("a1");
    // …and the persistence subscription wrote the re-pointed selection.
    expect(store.get("ai:subagent:writer:modelId")).toBe("a1");
    expect(h.remap).toHaveBeenCalledWith("/proj", { b1: "a1" });
    expect(h.delKey).toHaveBeenCalledWith("mmc");
    expect(order).toEqual(["tx", "usage", "key"]);
  });
});
