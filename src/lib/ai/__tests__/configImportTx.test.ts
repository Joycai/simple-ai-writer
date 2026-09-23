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
  saveApiKey: vi.fn(async (_id: string, _key: string) => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));
vi.mock("../../project", () => ({
  getGlobalDb: async () => ({ execute: h.execute, select: h.select }),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../../keyStore", () => ({
  saveApiKey: h.saveApiKey,
  loadApiKey: async () => null,
}));
vi.mock("../../fs/transfer", () => ({
  openTextFileDialog: async () => null,
  saveTextFileDialog: async () => null,
}));

const { applyConfigImport, keyFailureMessage } = await import("../configTransfer");
import type { StagedConfigImport } from "../configTransfer";

const staged = (over: Partial<StagedConfigImport> = {}): StagedConfigImport => ({
  path: "/backup.json",
  feeGroups: [],
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
  legacyPrices: false,
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
  h.saveApiKey.mockReset().mockResolvedValue(undefined);
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

  it("reports a keyring failure as a result, not a throw — the rows are already committed", async () => {
    // A throw read as 导入失败 to both callers, so they skipped
    // refreshAfterConfigImport over rows that had landed: the stores kept the
    // pre-restore config until a restart.
    h.saveApiKey.mockImplementation(async (id: string) => {
      if (id === "p2") throw new Error("keyring locked");
    });
    const key = (id: string, name: string) => ({
      id, name, baseUrl: "https://x/v1", apiStandard: "openai_compat" as const, createdAt: 1, apiKey: `sk-${id}`,
    });

    const result = await applyConfigImport(staged({ providers: [key("p1", "Relay"), key("p2", "Backup")] }));

    expect(result.failedKeys).toEqual(["Backup"]);
    expect(txArgs().statements.length).toBeGreaterThan(0);
    // Every key is attempted; one miss does not stop the rest.
    expect(h.saveApiKey).toHaveBeenCalledTimes(2);
    expect(keyFailureMessage(result.failedKeys)).toBe(
      "Imported the configuration, but could not store the API key for: Backup. Enter those keys by hand.",
    );
  });

  it("returns no failed keys on a clean import", async () => {
    const result = await applyConfigImport(staged());

    expect(result.failedKeys).toEqual([]);
    expect(keyFailureMessage(result.failedKeys)).toBeNull();
  });

  it("skips the round trip entirely for a backup that carries only preferences", async () => {
    await applyConfigImport(staged({ providers: [], models: [], prompts: [], prefs: [["app:theme", "dark"]] }));

    expect(h.invoke.mock.calls.filter((c) => c[0] === "sqlite_transaction")).toHaveLength(0);
  });
});

describe("applyConfigImport · fee_migrated", () => {
  /** 事务里那条模型语句，列名和值拉成一行。 */
  function modelRow(): Record<string, unknown> {
    const stmt = batch().find((x) => /INTO models/.test(x.sql))!;
    const cols = /\(([^)]*)\)\s*VALUES/.exec(stmt.sql)![1].split(",").map((c) => c.trim());
    return Object.fromEntries(cols.map((c, i) => [c, stmt.values[i]]));
  }

  it("v3 的包：模型盖章，不管绑没绑组", async () => {
    await applyConfigImport(staged());
    expect(modelRow()).toMatchObject({ fee_group_id: null, fee_migrated: 1 });

    h.invoke.mockClear();
    const [m] = staged().models;
    await applyConfigImport(staged({ models: [{ ...m, feeGroupId: "g1" }] }));
    expect(modelRow()).toMatchObject({ fee_group_id: "g1", fee_migrated: 1 });
  });

  it("v2 及更早的包：留 NULL，交给迁移按旧价归组", async () => {
    await applyConfigImport(staged({ legacyPrices: true }));
    expect(modelRow()).toMatchObject({ price_in: 1, price_out: 2, fee_migrated: null });
  });
});

/**
 * 还原之后当场迁移。迁移在事务**之后**跑才看得见刚落库的行——事务之前那次
 * （`configDb()` 里的 `ensureAiSchema`）只扫得到还原之前就在库里的行。
 */
describe("applyConfigImport · 事务之后的迁移", () => {
  const isMigrationScan = (sql: string) => /FROM models WHERE fee_migrated IS NULL/.test(sql);

  it("事务提交之后再扫一遍待迁移的行", async () => {
    const order: string[] = [];
    h.invoke.mockImplementation(async (cmd: string) => { order.push(cmd); return undefined; });
    h.select.mockImplementation((async (sql: string) => {
      if (isMigrationScan(sql)) order.push("migrate");
      return [];
    }) as never);

    await applyConfigImport(staged({ legacyPrices: true }));

    // 第一次扫描是事务前 ensureAiSchema 的，最后一次必须在事务之后。先确认
    // 事务真的发出了，否则 indexOf 是 -1，下面那条恒真。
    expect(order).toContain("sqlite_transaction");
    expect(order.lastIndexOf("migrate")).toBeGreaterThan(order.indexOf("sqlite_transaction"));
  });

  it("迁移失败不把一次已经落库的还原报成失败", async () => {
    let scans = 0;
    h.select.mockImplementation((async (sql: string) => {
      // 事务前那次放过（ensureAiSchema 自己会吞），事务后那次抛。
      if (isMigrationScan(sql) && ++scans > 1) throw new Error("database is locked");
      return [];
    }) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 和正常的还原长得一样：没有失败的 Key，调用方照常刷新、照常报成功。
      await expect(applyConfigImport(staged({ legacyPrices: true }))).resolves.toEqual({ failedKeys: [] });
      expect(scans).toBe(2);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("效果而不只是时机：v2 的模型在 applyConfigImport 返回之前已经绑上了组", async () => {
    // 事务把模型行「写进库」之后，迁移那次扫描才看得见它——事务前那次看不见。
    // 这里只模拟这一件事：事务发出之后，待迁移的扫描答出这一行。
    let committed = false;
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sqlite_transaction") committed = true;
      return undefined;
    });
    h.select.mockImplementation((async (sql: string) => {
      if (isMigrationScan(sql) && committed) {
        return [{
          id: "m1", name: "GPT-X", fee_group_id: null,
          price_in: 1, price_cached_in: 0, price_out: 2, price_per_image: null, price_per_second: null,
        }];
      }
      return [];
    }) as never);

    await applyConfigImport(staged({ legacyPrices: true }));

    // 迁移走的是池化句柄（和 aiStore 刷新时读的是同一个库），不是事务那条连接。
    const pooled = h.execute.mock.calls as unknown as [string, unknown[]?][];
    const inserted = pooled.find(([sql]) => /INSERT INTO fee_groups/.test(sql));
    expect(inserted, "迁移应当按旧价建一个组").toBeDefined();
    const groupId = inserted![1]![0];
    const bound = pooled.find(([sql, v]) => /UPDATE models SET fee_group_id/.test(sql) && v?.[1] === "m1");
    expect(bound?.[1]?.[0]).toBe(groupId);
  });
});
