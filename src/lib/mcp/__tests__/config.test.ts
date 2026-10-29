import { beforeEach, describe, expect, it, vi } from "vitest";
const prefs = new Map<string, string>();
const secrets = new Map<string, string>();
const save = vi.fn(async (id: string, value: string) => { secrets.set(id, value); });
const wipe = vi.fn(async (ids: string[]) => { ids.forEach((id) => secrets.delete(id)); return { failed: 0, removed: ids.length }; });
vi.mock("../../prefs", () => ({ readPref: (k: string) => prefs.get(k) ?? null,
  writePref: (k: string, v: string) => prefs.set(k, v), writePrefConfirmed: async (k: string, v: string) => { prefs.set(k, v); } }));
vi.mock("../../keyStore", () => ({ saveApiKey: (...args: [string, string]) => save(...args),
  loadApiKey: async (id: string) => secrets.get(id) ?? null, clearAllSecrets: (ids: string[]) => wipe(ids) }));
import { endpoint, importMcpServers, mcpHeaders, parseMcpImport, readMcpServers, removeMcpServer } from "../config";
vi.mock("../catalogueDb", () => ({ deleteCatalogueRow: vi.fn(async () => {}) }));
const raw = JSON.stringify({ mcpServers: { images: { url: "http://127.0.0.1:39287/mcp", headers: { Authorization: "Bearer test-secret" } } } });
beforeEach(() => { prefs.clear(); secrets.clear(); vi.clearAllMocks(); });
describe("MCP configuration", () => {
  it("imports the common JSON shape without storing header values in preferences", async () => {
    await importMcpServers(raw);
    expect(readMcpServers()).toHaveLength(1);
    expect(readMcpServers()[0].enabled).toBe(true);
    expect(JSON.stringify([...prefs])).not.toContain("test-secret");
    expect(await mcpHeaders(readMcpServers()[0])).toEqual({ Authorization: "Bearer test-secret" });
  });
  it("updates a server in place and invalidates pending approvals", async () => {
    await importMcpServers(raw); const before = readMcpServers()[0];
    await importMcpServers(raw); const after = readMcpServers()[0];
    expect(after.id).toBe(before.id); expect(after.revision).not.toBe(before.revision);
    expect(readMcpServers()).toHaveLength(1);
  });
  it("keeps a disabled account record when keyring save fails", async () => {
    save.mockRejectedValueOnce(new Error("locked"));
    await expect(importMcpServers(raw)).rejects.toThrow("credentials");
    expect(readMcpServers()[0].enabled).toBe(false);
  });
  it("does not lose the account when keyring deletion fails", async () => {
    await importMcpServers(raw); wipe.mockResolvedValueOnce({ failed: 1, removed: 0 });
    await expect(removeMcpServer(readMcpServers()[0].id)).rejects.toThrow();
    expect(readMcpServers()[0].enabled).toBe(false);
  });
  it("removes credentials before removing their account record", async () => {
    await importMcpServers(raw); await removeMcpServer(readMcpServers()[0].id);
    expect(secrets.size).toBe(0); expect(readMcpServers()).toEqual([]);
  });
  it("rejects stdio, credential URLs, nonlocal plaintext and protocol header overrides", () => {
    for (const url of ["http://example.com/mcp", "https://u:p@example.com/mcp", "https://example.com/mcp?token=x", "file:///tmp/mcp"]) {
      expect(() => endpoint(url)).toThrow();
    }
    expect(() => parseMcpImport('{"mcpServers":{"x":{"command":"npx"}}}')).toThrow();
    expect(() => parseMcpImport(raw.replace("Authorization", "Mcp-Session-Id"))).toThrow();
    expect(() => parseMcpImport("Bearer private-value")).toThrow("Invalid MCP JSON.");
  });
});

describe("MCP editing", () => {
  it("keeps header values out of the form and retains them during rename", async () => {
    const { saveMcpServer, mcpHeaderNames, connectionRevision } = await import("../config");
    await importMcpServers(raw); const before = readMcpServers()[0];
    expect(await mcpHeaderNames(before)).toEqual(["Authorization"]);
    const after = await saveMcpServer({ ...before, name: "renamed" });
    expect(await mcpHeaders(after)).toEqual({ Authorization: "Bearer test-secret" });
    expect(connectionRevision(after)).toBe(connectionRevision(before)); expect(after.revision).not.toBe(before.revision);
  });
  it("patches and removes headers explicitly, invalidating the connection", async () => {
    const { saveMcpServer, connectionRevision } = await import("../config");
    await importMcpServers(raw); const before = readMcpServers()[0];
    const after = await saveMcpServer({ ...before, headers: { Authorization: null, "X-Api-Key": "new-secret" } });
    expect(await mcpHeaders(after)).toEqual({ "X-Api-Key": "new-secret" });
    expect(connectionRevision(after)).not.toBe(connectionRevision(before));
    expect(JSON.stringify([...prefs])).not.toContain("new-secret");
  });
  it("rejects duplicate names and stale editor revisions", async () => {
    const { saveMcpServer } = await import("../config");
    await importMcpServers(raw); const before = readMcpServers()[0];
    await expect(saveMcpServer({ name: "IMAGES", url: before.url, enabled: true, headers: {} })).rejects.toThrow("duplicate");
    await saveMcpServer({ ...before, name: "new" });
    await expect(saveMcpServer({ ...before, name: "stale" })).rejects.toThrow("changed");
  });
  it("serializes additions without losing a service", async () => {
    const { saveMcpServer } = await import("../config");
    await Promise.all(["a", "b"].map(name => saveMcpServer({ name, url: "https://example.com/mcp", enabled: true, headers: {} })));
    expect(readMcpServers().map(s => s.name)).toEqual(["a", "b"]);
  });
});
