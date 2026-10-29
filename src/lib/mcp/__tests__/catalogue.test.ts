import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  server: { id: "s", name: "search", url: "https://example.com/mcp", revision: "1", connectionRevision: "c1", enabled: true },
  removed: false, enabled: true, changed: () => {}, rows: new Map<string, string>(), list: vi.fn(), writes: vi.fn(),
}));
vi.mock("../config", async original => ({ ...await original<typeof import("../config")>(),
  readMcpServers: () => h.removed ? [] : [h.server], isMcpEnabled: () => h.enabled,
  subscribeMcpConfig: (fn: () => void) => { h.changed = fn; return () => {}; },
}));
vi.mock("../catalogueDb", () => ({ readCatalogueRow: async (id: string) => h.rows.get(id),
  writeCatalogueRow: async (id: string, _connection: string, raw: string) => { h.writes(raw); h.rows.set(id, raw); return true; },
  deleteCatalogueRow: async (id: string) => { h.rows.delete(id); }, clearCatalogueRows: async () => { h.rows.clear(); },
}));
vi.mock("../client", () => ({ withMcp: async (_server: unknown, signal: AbortSignal, run: (c: unknown) => Promise<unknown>) => {
  signal.throwIfAborted(); return run({ info: { protocolVersion: "2024-11-05", name: "test" }, listTools: () => h.list(signal) });
} }));
import { browseCatalogue, catalogueState, clearMcpCatalogues, discoverCatalogue, hydrateCatalogue, parseCatalogue, refreshCatalogue } from "../catalogue";
const tool = { name: "search", inputSchema: { type: "object" } };
const snapshot = () => ({ format: 1, connection: "c1", fetchedAt: Date.now(), tools: [tool], info: {} });
beforeEach(async () => {
  await clearMcpCatalogues(); h.server.connectionRevision = "c1"; h.server.revision = "1"; h.server.enabled = true;
  h.removed = false; h.enabled = true; h.list.mockReset().mockResolvedValue([tool]); h.writes.mockClear();
});
describe("persistent MCP catalogues", () => {
  it("hydrates after restart without a network request and preserves full schemas", async () => {
    h.rows.set("s", JSON.stringify(snapshot())); await hydrateCatalogue(h.server);
    expect((await discoverCatalogue(h.server)).tools).toEqual([tool]); expect(h.list).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent consumers and isolates one consumer's cancellation", async () => {
    let finish!: (v: unknown) => void;
    h.list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const a = new AbortController(); const first = refreshCatalogue(h.server, a.signal); const second = refreshCatalogue(h.server);
    const rejected = expect(first).rejects.toThrow("cancelled"); a.abort(); finish([tool]);
    await rejected; expect((await second).tools).toEqual([tool]); expect(h.list).toHaveBeenCalledTimes(1);
  });
  it("keeps the last successful cache and timestamp after network failure", async () => {
    const before = await refreshCatalogue(h.server); h.list.mockRejectedValueOnce(new Error("offline"));
    await expect(refreshCatalogue(h.server)).rejects.toThrow("offline");
    expect(catalogueState(h.server).snapshot).toEqual(before); expect(JSON.parse(h.rows.get("s")!).fetchedAt).toBe(before.fetchedAt);
  });
  it("does not publish or persist a late response after connection edits", async () => {
    let finish!: (v: unknown) => void;
    h.list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const before = { ...h.server }; const pending = refreshCatalogue(before);
    const rejected = expect(pending).rejects.toThrow(); h.server.connectionRevision = "c2"; h.changed(); finish([tool]); await rejected;
    expect(catalogueState(h.server).snapshot).toBeUndefined(); expect(h.rows.has("s")).toBe(false);
  });
  it("does not resurrect a deleted service after a late response", async () => {
    let finish!: (v: unknown) => void; h.list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = refreshCatalogue(h.server); const rejected = expect(pending).rejects.toThrow();
    h.removed = true; h.changed(); finish([tool]); await rejected; expect(h.rows.has("s")).toBe(false);
  });
  it("keeps the catalogue on rename or enable changes but respects disabled discovery", async () => {
    await refreshCatalogue(h.server); h.server.revision = "2"; h.server.enabled = false; h.changed();
    await browseCatalogue(h.server); expect(catalogueState(h.server).snapshot?.tools).toEqual([tool]); expect(h.list).toHaveBeenCalledTimes(1);
  });
  it("loads stale snapshots offline when the Beta is off without starting requests", async () => {
    h.enabled = false; h.rows.set("s", JSON.stringify({ ...snapshot(), fetchedAt: Date.now() - 172800000 }));
    await browseCatalogue(h.server); expect(catalogueState(h.server).snapshot?.tools).toEqual([tool]); expect(h.list).not.toHaveBeenCalled();
  });
  it("cools down automatic failures but allows explicit retries", async () => {
    h.list.mockRejectedValue(new Error("offline")); await expect(browseCatalogue(h.server)).rejects.toThrow();
    await browseCatalogue(h.server); expect(h.list).toHaveBeenCalledTimes(1);
    await expect(refreshCatalogue(h.server)).rejects.toThrow(); expect(h.list).toHaveBeenCalledTimes(2);
  });
  it("distinguishes an empty catalogue from an absent one", async () => {
    h.list.mockResolvedValue([]); await refreshCatalogue(h.server); expect(catalogueState(h.server).snapshot?.tools).toEqual([]);
  });
  it("rejects corrupt, foreign, oversized and duplicate tool caches", () => {
    expect(parseCatalogue("bad", "c1")).toBeUndefined();
    expect(parseCatalogue(JSON.stringify(snapshot()), "other")).toBeUndefined();
    expect(parseCatalogue(JSON.stringify({ ...snapshot(), format: 7 }), "c1")).toBeUndefined();
    expect(parseCatalogue(JSON.stringify({ ...snapshot(), tools: [tool, tool] }), "c1")).toBeUndefined();
    expect(parseCatalogue(JSON.stringify({ ...snapshot(), tools: [{ ...tool, inputSchema: { type: "array" } }] }), "c1")).toBeUndefined();
  });
});
