/**
 * resetApp — 清除的顺序，以及被拒绝时的停手。
 *
 * `providers` 那几行是「钥匙串里有哪些账户」的唯一记录，所以顺序不是风格问题：
 * 先删行再删密钥，中间断了就留下一堆再也叫不出名字的密钥。这里钉住三条——
 * 钥匙串先走、被拒就一行不动、真走完时该清的一个不漏。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  timeline: [] as string[],
  invoke: vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
    h.timeline.push(`invoke:${cmd}`);
    return undefined as unknown;
  }),
  execute: vi.fn(async (sql: string) => {
    h.timeline.push(`execute:${sql}`);
  }),
  clearAllSecrets: vi.fn(async (accounts: string[]) => {
    h.timeline.push(`secrets:${accounts.join(",")}`);
    return { removed: accounts.length, failed: 0 };
  }),
  clearAllPrefs: vi.fn(async () => {
    h.timeline.push("prefs:cleared");
  }),
  serverUrl: "",
  providers: [{ id: "p1" }, { id: "p2" }] as { id: string }[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../project", () => ({
  getGlobalDb: async () => ({ execute: h.execute, select: async () => [] }),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../ai/configDb", () => ({
  ensureAiSchema: async () => {},
  listProviders: async () => h.providers,
  listModels: async () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
  listPrompts: async () => [{ id: "s1" }],
  dropLegacyKeyTable: async () => {
    h.timeline.push("legacy:dropped");
  },
}));
vi.mock("../docx/presets", () => ({ loadCustomFormats: async () => [{ id: "f1" }] }));
vi.mock("../keyStore", () => ({ clearAllSecrets: h.clearAllSecrets }));
vi.mock("../prefs", () => ({
  clearAllPrefs: h.clearAllPrefs,
  prefEntries: () => [["app:theme", "dark"] as [string, string]],
}));
vi.mock("../sync/config", () => ({
  getServerUrl: () => h.serverUrl,
  syncTokenAccount: (url: string) => `kbsync:${url}`,
}));

const { collectResetInventory, resetApp, SecretWipeError } = await import("../appReset");

/** The tables named by the one `sqlite_transaction` call. */
function txTables(): string[] {
  const calls = h.invoke.mock.calls.filter((c) => c[0] === "sqlite_transaction");
  expect(calls, "expected exactly one sqlite_transaction invoke").toHaveLength(1);
  const { statements } = calls[0][1] as { statements: { sql: string }[] };
  return statements.map((s) => /DELETE FROM (\w+)/.exec(s.sql)?.[1] ?? s.sql);
}

beforeEach(() => {
  h.timeline.length = 0;
  h.invoke.mockClear();
  h.execute.mockClear();
  h.clearAllSecrets.mockClear().mockImplementation(async (accounts: string[]) => {
    h.timeline.push(`secrets:${accounts.join(",")}`);
    return { removed: accounts.length, failed: 0 };
  });
  h.clearAllPrefs.mockClear();
  h.serverUrl = "";
  h.providers = [{ id: "p1" }, { id: "p2" }];
});

describe("collectResetInventory", () => {
  it("counts the real thing rather than describing it", async () => {
    const inv = await collectResetInventory();
    expect(inv).toMatchObject({ providers: 2, models: 3, prompts: 1, docFormats: 1, prefs: 1 });
  });

  it("names one keyring account per provider, plus the sync token when a server is set", async () => {
    expect((await collectResetInventory()).secrets).toBe(2);
    h.serverUrl = "https://kb.example";
    expect((await collectResetInventory()).secrets).toBe(3);
  });
});

describe("resetApp", () => {
  it("clears the keyring before the rows that name its accounts", async () => {
    h.serverUrl = "https://kb.example";
    await resetApp();

    const secrets = h.timeline.findIndex((e) => e.startsWith("secrets:"));
    const tx = h.timeline.indexOf("invoke:sqlite_transaction");
    expect(secrets).toBeGreaterThanOrEqual(0);
    expect(tx).toBeGreaterThan(secrets);
    expect(h.clearAllSecrets).toHaveBeenCalledWith(["p1", "p2", "kbsync:https://kb.example"]);
  });

  it("touches nothing when the keyring refuses", async () => {
    h.clearAllSecrets.mockResolvedValue({ removed: 0, failed: 2 });

    await expect(resetApp()).rejects.toBeInstanceOf(SecretWipeError);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.clearAllPrefs).not.toHaveBeenCalled();
  });

  it("drops every config table, models before the providers they reference", async () => {
    await resetApp();

    expect(txTables()).toEqual(["models", "providers", "prompts"]);
    // 排版格式和遗留的明文密钥表没有外键牵连，走事务外的尽力而为一路。
    expect(h.execute.mock.calls.map((c) => String(c[0]))).toContain("DELETE FROM doc_format");
    expect(h.timeline).toContain("legacy:dropped");
    expect(h.clearAllPrefs).toHaveBeenCalledTimes(1);
  });

  it("survives a doc_format table that was never created", async () => {
    h.execute.mockRejectedValueOnce(new Error("no such table: doc_format"));

    await expect(resetApp()).resolves.toMatchObject({ secretsRemoved: 2 });
    expect(h.clearAllPrefs).toHaveBeenCalledTimes(1);
  });

  it("reports the counts it removed, read before anything was deleted", async () => {
    const summary = await resetApp();
    expect(summary.inventory).toMatchObject({ providers: 2, models: 3, prefs: 1 });
    expect(summary.secretsRemoved).toBe(2);
  });
});
