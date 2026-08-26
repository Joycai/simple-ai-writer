/**
 * applyConfigImport — how the restore's writes reach the database.
 *
 * They used to go as `db.execute("BEGIN")`, the per-row helpers, then
 * `db.execute("COMMIT")`. `@tauri-apps/plugin-sql` is a connection *pool*, so
 * those were separate connections: the writes fell outside the transaction the
 * BEGIN had opened, and once one landed inside it the connection holding
 * SQLite's write lock made the next statement fail with
 * `(code: 5) database is locked` — a config the app could have merged fine
 * reported as 导入失败. (Reproduced against sqlx directly; the same pool +
 * separate-execute pattern raises exactly that error.)
 *
 * Every write now goes through the `sqlite_transaction` command, which runs the
 * batch on one private connection. These tests pin the two properties the fix
 * rests on: no BEGIN ever goes through the pooled handle, and the whole batch
 * is one call in dependency order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => undefined as unknown),
  execute: vi.fn(async (_sql: string, _values?: unknown[]) => {}),
  select: vi.fn(async () => [] as { name: string }[]),
  saveApiKey: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));
vi.mock("../project", () => ({
  getGlobalDb: async () => ({ execute: h.execute, select: h.select }),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../keyStore", () => ({
  saveApiKey: h.saveApiKey,
  loadApiKey: async () => null,
}));
vi.mock("../fs/transfer", () => ({
  openTextFileDialog: async () => null,
  saveTextFileDialog: async () => null,
}));

const { applyConfigImport } = await import("../ai/configTransfer");
import type { StagedConfigImport } from "../ai/configTransfer";

const staged = (over: Partial<StagedConfigImport> = {}): StagedConfigImport => ({
  path: "/backup.json",
  providers: [
    { id: "p1", name: "Relay", baseUrl: "https://x/v1", apiStandard: "openai_compat", createdAt: 1 },
  ],
  models: [
    {
      id: "m1", providerId: "p1", modelId: "gpt-x", name: "GPT-X", type: "text",
      priceIn: 1, priceCachedIn: 0, priceOut: 2, enabled: true,
    },
  ],
  prompts: [{ id: "s1", name: "系统", content: "hi", scene: "system" }],
  prefs: [],
  docFormats: [],
  keyCount: 0,
  ...over,
});

/** The arguments of the one `sqlite_transaction` call. */
function txArgs(): { dbPath: string; statements: { sql: string; values: unknown[] }[] } {
  const calls = h.invoke.mock.calls.filter((c) => c[0] === "sqlite_transaction");
  expect(calls, "expected exactly one sqlite_transaction invoke").toHaveLength(1);
  return calls[0][1] as { dbPath: string; statements: { sql: string; values: unknown[] }[] };
}

const batch = () => txArgs().statements;

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(undefined);
  h.execute.mockClear();
  h.select.mockClear().mockResolvedValue([]);
  h.saveApiKey.mockClear();
});

describe("applyConfigImport", () => {
  it("never opens a transaction through the pooled handle", async () => {
    await applyConfigImport(staged());

    const pooled = h.execute.mock.calls.map((c) => String(c[0]));
    // ensureAiSchema's CREATE TABLE / PRAGMA work still goes through the pool;
    // what must not is a bare transaction control statement.
    expect(pooled.some((s) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(s))).toBe(false);
    expect(pooled.some((s) => /CREATE TABLE IF NOT EXISTS providers/.test(s))).toBe(true);
  });

  it("sends every row as one transaction, providers before the models that reference them", async () => {
    await applyConfigImport(staged());

    const tables = batch().map((s) => /INTO (\w+)/.exec(s.sql)?.[1]);
    expect(tables).toEqual(["providers", "models", "prompts"]);
  });

  it("passes the config database's own path, not a project one", async () => {
    await applyConfigImport(staged());

    expect(txArgs().dbPath).toBe("/app-data/config.db");
  });

  it("keeps the API key out of the row it writes", async () => {
    await applyConfigImport(
      staged({
        providers: [{
          id: "p1", name: "Relay", baseUrl: "https://x/v1", apiStandard: "openai_compat",
          createdAt: 1, apiKey: "sk-secret",
        }],
      }),
    );

    const provider = batch()[0];
    expect(provider.values).not.toContain("sk-secret");
    // It goes to the keyring instead, after the rows are committed.
    expect(h.saveApiKey).toHaveBeenCalledWith("p1", "sk-secret");
  });

  it("propagates a failed transaction instead of reporting a clean import", async () => {
    h.invoke.mockRejectedValueOnce(new Error("error returned from database: (code: 5) database is locked"));

    await expect(applyConfigImport(staged())).rejects.toThrow(/database is locked/);
    // Nothing after the transaction runs — no keys, no preferences.
    expect(h.saveApiKey).not.toHaveBeenCalled();
  });

  it("skips the round trip entirely for a backup that carries only preferences", async () => {
    await applyConfigImport(staged({ providers: [], models: [], prompts: [], prefs: [["app:theme", "dark"]] }));

    expect(h.invoke.mock.calls.filter((c) => c[0] === "sqlite_transaction")).toHaveLength(0);
  });
});
