import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";

import { ensureUsageSchema } from "./ai/usageSchema";
import { backfillUsagePartsQuietly } from "./ai/usageBackfill";
import { toPosixPath } from "./paths";

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

/**
 * Folder picking happens on the Rust side (project_open_dialog) so the picked
 * directory can be registered as an allowed root for the scoped fs_* commands.
 */
export async function openProjectFolder(): Promise<string | null> {
  const picked = await invoke<string | null>("project_open_dialog");
  // One of the three doors a host-spelled path enters through — see
  // `docs/feature/path-spelling-plan.md`. This one is the root of everything: the
  // project path is compared against, joined onto, and persisted into the
  // recents list, so it must have a single spelling from here on.
  return picked === null ? null : toPosixPath(picked);
}

/**
 * Register an existing project (from the recents list) as an allowed fs root.
 * Rejects directories without an on-disk `.ai-writer` marker.
 */
export async function registerProjectRoot(path: string): Promise<void> {
  await invoke("project_register_root", { path });
}

/**
 * Create the project's directory skeleton.
 *
 * `categories` decides the `.ai-writer/lore/<category>` folders and comes from
 * the project's workspace profile (see lib/profile) — so the active profile must
 * be resolved *before* this runs. Additive: re-scaffolding after a profile
 * switch adds the new folders and leaves the previous ones in place.
 */
export async function scaffoldProject(
  projectPath: string,
  categories: string[],
): Promise<void> {
  await invoke("scaffold_project", { projectPath, categories });
}

/**
 * The project's file tree, with every path in the app's POSIX spelling.
 *
 * Normalising the project path alone would not be enough: Rust builds each
 * child with `DirEntry::path()`, whose `PathBuf::push` uses the **host's**
 * separator at every level regardless of what the parent was spelled with —
 * hand it `D:/书` and it answers `D:/书\第一章.md`. So the tree is normalised
 * here, on the way in, rather than asking the Rust side to answer in a
 * spelling it does not itself use.
 */
export async function readDirRecursive(dirPath: string): Promise<FileNode[]> {
  return normalizeTree(await invoke<FileNode[]>("read_dir_recursive", { dirPath }));
}

function normalizeTree(nodes: FileNode[]): FileNode[] {
  return nodes.map((n) => ({
    ...n,
    path: toPosixPath(n.path),
    children: n.children ? normalizeTree(n.children) : n.children,
  }));
}

// ── Per-project DB (lore, token usage, project settings) ─────────────────────

// Keyed by project path rather than a single shared handle: openProject calls
// resetDb() then awaits getDb(newPath), but that await can lose a race with a
// still-in-flight getDb(oldPath) from whatever the previous project's call
// site was doing. With one unkeyed slot, the older load resolving later would
// silently overwrite the cache with the wrong project's handle — and every
// caller trusts whatever getDb(projectPath) hands back without rechecking the
// path. Caching the in-flight promise per path means a stale load for
// oldPath can never land in newPath's slot, and concurrent callers asking for
// the same path share one load instead of racing separate Database.load calls.
const dbCache = new Map<string, Promise<Awaited<ReturnType<typeof Database.load>>>>();

/**
 * 这个项目那本账在磁盘上的位置。
 *
 * 单独一个函数而不是在用到的两处各写一遍那串字面量：事务走不了下面那个句柄
 * ——SQL 插件是连接池，`sqlTransaction`（lib/sqlTx）要自己开一条连接，所以它
 * 要的是文件本身。在一处派生，通往同一个库的两条路就不可能对「这是哪个文件」
 * 产生分歧（`getGlobalDbPath()` 是同一条理由，只是它有模块外的调用方才导出）。
 */
function getProjectDbPath(projectPath: string): string {
  return `${projectPath}/.ai-writer/project.db`;
}

export async function getDb(projectPath: string) {
  let dbPromise = dbCache.get(projectPath);
  if (!dbPromise) {
    dbPromise = (async () => {
      const dbPath = getProjectDbPath(projectPath);
      const db = await Database.load(`sqlite:${dbPath}`);
      await initSchema(db, projectPath);
      return db;
    })();
    dbCache.set(projectPath, dbPromise);
  }
  try {
    return await dbPromise;
  } catch (e) {
    // Don't leave a failed load cached — the next call should retry, not
    // keep rethrowing the same stale rejection forever.
    if (dbCache.get(projectPath) === dbPromise) dbCache.delete(projectPath);
    throw e;
  }
}

export function resetDb() {
  dbCache.clear();
}

// ── Global app-level DB (AI providers, models, prompts) ──────────────────────
// Stored in appDataDir so it is available without a project open.

let _globalDb: Awaited<ReturnType<typeof Database.load>> | null = null;

/**
 * The config database's path on disk.
 *
 * Exported because a transaction cannot go through the handle above: the SQL
 * plugin is a pool, so `sqlTransaction` (lib/sqlTx) needs the file itself to
 * open a connection of its own. Derived here rather than at the call site so
 * both routes to this database can never disagree about which file it is.
 */
export async function getGlobalDbPath(): Promise<string> {
  const { appDataDir } = await import("@tauri-apps/api/path");
  return `${await appDataDir()}/config.db`;
}

export async function getGlobalDb() {
  if (_globalDb) return _globalDb;
  _globalDb = await Database.load(`sqlite:${await getGlobalDbPath()}`);
  return _globalDb;
}

/**
 * Tables this schema used to create and nothing ever read.
 *
 * `settings` never had a single reader or writer. `lore_entities` is the
 * remains of an earlier design where the knowledge base was indexed in SQLite
 * (hence `embedding_status`); the lore tree under `.ai-writer/lore/` has been
 * the sole source of truth since, and `loreStore` rebuilds its index by
 * scanning that tree on every project open. Neither table has ever been read
 * back by any shipped code path, so dropping them loses nothing — while
 * leaving them in place makes the schema describe a design the app no longer
 * has, which is what sent the last reader looking for the code that maintains
 * them.
 */
export const DEAD_PROJECT_TABLES = ["settings", "lore_entities"] as const;

/**
 * Best-effort drop of the dead tables.
 *
 * Deliberately non-fatal: this runs inside the project-open path, and a
 * cleanup that can't complete (a locked database, a second window holding the
 * file) must not stop the author from opening their project. The next open
 * tries again.
 */
async function dropDeadTables(db: Awaited<ReturnType<typeof Database.load>>) {
  for (const table of DEAD_PROJECT_TABLES) {
    try {
      await db.execute(`DROP TABLE IF EXISTS ${table}`);
    } catch (e) {
      console.warn(`[project] could not drop the unused '${table}' table:`, e);
    }
  }
}

async function initSchema(db: Awaited<ReturnType<typeof Database.load>>, projectPath: string) {
  // 项目用量。表结构与 appDataDir 里的那份总体用量共用一处定义
  // （lib/ai/usageSchema.ts）——两张表长歪了，用量页在「本项目 / 全部」
  // 之间一切就会少掉几列，而那种少法不报错。
  await ensureUsageSchema(db, "project");
  // 补列之后把老行的分项补上——只补对得上账的那些，路径要单独传是因为事务
  // 走不了这个句柄（lib/sqlTx）。它自己吞掉异常：账目的事不配让项目开不了。
  //
  // **故意 `await`，没有放飞。** 挡在这里，升级后第一次打开项目会慢一下；
  // 之后每次都不慢——每行只看一次（`cost_split_checked`），看完
  // `idx_usage_unchecked` 这个部分索引就是空的，再开库只是一次落空的查找。
  // 换成不 await 的话，回填会和「项目已经能用了」之后
  // 的 `recordUsage` 抢同一张表的写锁，而 `recordUsage` 撞上 locked 只会被
  // 自己的 try 吞掉——账少一行，没有任何东西报错。**一次性的慢，好过悄悄
  // 掉一行账。**
  await backfillUsagePartsQuietly(db, getProjectDbPath(projectPath), "project.db");

  // Persisted 对话助手 sessions — one JSON blob per session, newest few kept
  // (lib/agent/sessionDb owns the cap and all reads/writes). `pinned` is the
  // author's exemption from that cap.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      preview TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  await addChatSessionPinned(db);
  await addChatSessionTitle(db);

  await dropDeadTables(db);
}

/**
 * `pinned` on an existing project's `chat_sessions`.
 *
 * The table shipped without it, so the CREATE above is a no-op in every
 * project that already has one — the column only arrives through an ALTER.
 * Mirrors lib/ai/configDb's `addColumn`, including why `duplicate column name`
 * is success rather than failure: this runs on every `getDb`, and a second
 * window opening the same project can win the race between the read and the
 * write. Any other error propagates — a chat_sessions table without this
 * column would let the cap prune a session the author pinned.
 */
async function addChatSessionPinned(db: Awaited<ReturnType<typeof Database.load>>) {
  await addChatSessionColumn(db, "pinned", "INTEGER NOT NULL DEFAULT 0");
}

/**
 * `title` on an existing project's `chat_sessions` — the author's own name for
 * a conversation (docs/feature/agent/chat-sessions-plan.md §3). Same ALTER
 * discipline as `pinned`, and the same stakes: without the column the cap
 * would prune a session the author took the trouble to name.
 */
async function addChatSessionTitle(db: Awaited<ReturnType<typeof Database.load>>) {
  await addChatSessionColumn(db, "title", "TEXT NOT NULL DEFAULT ''");
}

async function addChatSessionColumn(
  db: Awaited<ReturnType<typeof Database.load>>,
  name: string,
  decl: string,
) {
  const columns = await db.select<{ name: string }[]>(`PRAGMA table_info(chat_sessions)`);
  if (columns.some((c) => c.name === name)) return;
  try {
    await db.execute(`ALTER TABLE chat_sessions ADD COLUMN ${name} ${decl}`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e))) throw e;
  }
}
