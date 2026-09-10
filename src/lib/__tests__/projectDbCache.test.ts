/**
 * project.ts's getDb — keyed per-project-path cache (Phase 5 fix).
 *
 * The cache used to be a single unkeyed `_db` slot: resetDb() then
 * getDb(newPath) raced against any still-in-flight getDb(oldPath) from
 * whatever the previous project's call site was doing, and the older load
 * resolving later would silently overwrite the cache with the wrong
 * project's handle — every caller trusted whatever came back without
 * rechecking the path. Keying by path means a stale load for oldPath can
 * never land in newPath's slot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  // `execute` declares its `sql` parameter so a test can assert on the
  // statements initSchema issues (see the initSchema block below). `select`
  // answers the schema's `PRAGMA table_info` probe: an empty column list means
  // "old database", which is the case the ALTER exists for.
  load: vi.fn(async (path: string) => ({
    path,
    execute: vi.fn(async (_sql: string) => {}),
    select: vi.fn(async (_sql: string) => [] as { name: string }[]),
  })),
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: h.load },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { DEAD_PROJECT_TABLES, getDb, resetDb } from "../project";

beforeEach(() => {
  h.load.mockClear();
  resetDb();
});

describe("getDb", () => {
  it("caches per project path — a second call for the same path reuses the handle", async () => {
    const a1 = await getDb("/proj-a");
    const a2 = await getDb("/proj-a");

    expect(a1).toBe(a2);
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it("loads a distinct handle per project path", async () => {
    const a = await getDb("/proj-a");
    const b = await getDb("/proj-b");

    expect(a).not.toBe(b);
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it("a slow load for an old path can't clobber a newer path's cached handle", async () => {
    let resolveOld: (db: Awaited<ReturnType<typeof h.load>>) => void;
    const oldLoad = new Promise<Awaited<ReturnType<typeof h.load>>>((res) => {
      resolveOld = res;
    });
    h.load.mockImplementationOnce(() => oldLoad); // getDb("/old") hangs

    const oldPromise = getDb("/old"); // in flight, not yet resolved
    resetDb(); // openProject switching away, as it does before loading the new path
    const newDb = await getDb("/new"); // resolves first

    // The stale /old load finally resolves — it must not overwrite /new's slot.
    resolveOld!({
      path: "/old",
      execute: vi.fn(async () => {}),
      select: vi.fn(async () => []),
    });
    await oldPromise;

    const newDbAgain = await getDb("/new");
    expect(newDbAgain).toBe(newDb);
  });

  it("does not cache a rejected load — the next call retries", async () => {
    h.load.mockRejectedValueOnce(new Error("connection refused"));

    await expect(getDb("/proj-a")).rejects.toThrow("connection refused");
    expect(h.load).toHaveBeenCalledTimes(1);

    const db = await getDb("/proj-a");
    expect(db).toBeTruthy();
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it("resetDb clears every cached path", async () => {
    await getDb("/proj-a");
    await getDb("/proj-b");
    resetDb();

    await getDb("/proj-a");
    expect(h.load).toHaveBeenCalledTimes(3);
  });
});

/**
 * `settings` and `lore_entities` were created on every project open and never
 * read or written by anything. `lore_entities` in particular (with its
 * `embedding_status` column) described a SQLite-indexed knowledge base the app
 * stopped having — the lore tree on disk is the source of truth — so the schema
 * was pointing later readers at code that does not exist.
 */
describe("initSchema", () => {
  const statements = async (path: string): Promise<string[]> => {
    const db = (await getDb(path)) as unknown as { execute: { mock: { calls: unknown[][] } } };
    return db.execute.mock.calls.map((c) => String(c[0]));
  };

  it("still creates the one table that is actually used", async () => {
    const sql = await statements("/proj-a");
    expect(sql.some((s) => /CREATE TABLE IF NOT EXISTS token_usage/.test(s))).toBe(true);
  });

  it("no longer creates the tables nothing reads", async () => {
    const sql = (await statements("/proj-a")).join("\n");
    for (const table of DEAD_PROJECT_TABLES) {
      expect(sql).not.toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
  });

  it("adds chat_sessions.pinned to a database that predates it", async () => {
    // The CREATE is a no-op wherever the table already exists, so a project
    // opened before pinning shipped can only get the column this way — and
    // without it the cap would prune sessions the author had pinned.
    const sql = (await statements("/proj-a")).join("\n");
    expect(sql).toMatch(/ALTER TABLE chat_sessions ADD COLUMN pinned\b/);
  });

  it("skips the ALTER when the column is already there", async () => {
    h.load.mockImplementationOnce(async (path: string) => ({
      path,
      execute: vi.fn(async (_sql: string) => {}),
      select: vi.fn(async (_sql: string) => [{ name: "id" }, { name: "pinned" }, { name: "title" }]),
    }));

    const sql = (await statements("/proj-current")).join("\n");
    expect(sql).not.toMatch(/ALTER TABLE chat_sessions/);
  });

  it("adds chat_sessions.title to a database that predates it", async () => {
    // Same discipline as `pinned`, same stakes: without the column the cap
    // would prune a conversation the author had named.
    const sql = (await statements("/proj-b")).join("\n");
    expect(sql).toMatch(/ALTER TABLE chat_sessions ADD COLUMN title\b/);
  });

  it("drops them from projects that already have them", async () => {
    const sql = await statements("/proj-a");
    for (const table of DEAD_PROJECT_TABLES) {
      expect(sql).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it("opens the project anyway when a drop fails", async () => {
    // A locked database must not stop the author getting into their project;
    // the next open retries the cleanup.
    h.load.mockImplementationOnce(async (path: string) => ({
      path,
      execute: vi.fn(async (sql: string) => {
        if (sql.startsWith("DROP TABLE")) throw new Error("database is locked");
      }),
      select: vi.fn(async (_sql: string) => [] as { name: string }[]),
    }));

    await expect(getDb("/proj-locked")).resolves.toBeTruthy();
  });
});
