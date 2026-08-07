import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";

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
  return invoke<string | null>("project_open_dialog");
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

export async function readDirRecursive(dirPath: string): Promise<FileNode[]> {
  return invoke("read_dir_recursive", { dirPath });
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

export async function getDb(projectPath: string) {
  let dbPromise = dbCache.get(projectPath);
  if (!dbPromise) {
    dbPromise = (async () => {
      const dbPath = `${projectPath}/.ai-writer/project.db`;
      const db = await Database.load(`sqlite:${dbPath}`);
      await initSchema(db);
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

export async function getGlobalDb() {
  if (_globalDb) return _globalDb;
  const { appDataDir } = await import("@tauri-apps/api/path");
  const dir = await appDataDir();
  _globalDb = await Database.load(`sqlite:${dir}/config.db`);
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

async function initSchema(db: Awaited<ReturnType<typeof Database.load>>) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      task TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  await dropDeadTables(db);
}
