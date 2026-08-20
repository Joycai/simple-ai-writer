/**
 * Where the app's own preferences live.
 *
 * They used to live in `localStorage`, scattered across whichever module
 * happened to need one, with the line between "this is a preference" and "this
 * is configuration" drawn by history rather than by anything. Two consequences
 * were real rather than cosmetic: clearing the webview's data (or moving to a
 * new machine) silently reset every one of them — including the recent-projects
 * list — and nothing could back them up, because nothing knew what the full set
 * was. This module is that missing registry, and `config.db` is now the store.
 *
 * ## The synchronous problem
 *
 * `localStorage` is synchronous and SQLite through the Tauri plugin is not,
 * while the two hottest readers are synchronous by nature: i18n picks a
 * language as its module initializes, and `appStore` computes its whole initial
 * state — theme, fonts, panel widths — at module scope. So the store here is a
 * plain in-memory `Map`, filled once by `hydratePrefs()` *before* anything that
 * reads a preference is imported (see `main.tsx`). Reads stay synchronous;
 * writes update the map and persist in the background.
 *
 * Until hydration — vitest, browser dev, and any path where the database
 * cannot be reached — every call falls through to `localStorage` exactly as
 * before. That is deliberate: a preference store that cannot reach its database
 * should cost the author their preferences syncing, not their app starting.
 */

/** Fixed keys. One row each. */
export const PREF_KEYS = [
  "app:theme",
  "app:language",
  "app:fontScheme",
  "app:markdownTheme",
  "app:sidebarWidth",
  "app:rightPanelWidth",
  "app:recentProjects",
  "app:loreBudgetTokens",
  "app:contextUtilization",
  "app:aiDrawerMode",
  "app:draftCount",
  "app:defaultMaxOutput",
  "app:apiLogEnabled",
  "app:pptxExportBeta",
  "app:notifyEnabled",
  "app:notifyApproval",
  "app:notifyDone",
  // Knowledge-base sync: the server's address. An installation property, not a
  // project one — several projects share one server. Its token lives in the OS
  // keyring instead (see lib/sync/config).
  "app:kbServerUrl",
  "manuscript:onboarding-done",
  "ai:activeModelId",
  "ai:activePromptId",
  "ai:memoryModelId",
  "ai:imageModelId",
  "ai:recentModels",
  "ai:blockedModels",
  "ai:subagent:search:modelId",
  "ai:subagent:search:enabled",
  "ai:subagent:vision:modelId",
  "ai:subagent:vision:enabled",
  "ai:subagent:longread:modelId",
  "ai:subagent:longread:enabled",
  "ai:subagent:pdf:modelId",
  "ai:subagent:pdf:enabled",
  "ai:subagent:imagegen:modelId",
  "ai:subagent:imagegen:enabled",
] as const;

/**
 * Key *families*: one row per project, the project's path appended.
 *
 * These are the ones that need collecting — see `prunePrefsWithPrefix`. A key
 * carrying an absolute path stops matching the moment the author renames or
 * moves the folder, and nothing was ever removing the leftovers.
 */
export const PINNED_LORE_PREFIX = "ai:pinnedLore:";
export const PREF_KEY_PREFIXES = [PINNED_LORE_PREFIX] as const;

/**
 * Preferences that describe *this machine* rather than the author's taste, and
 * so must not travel in a config backup: paths that exist on one computer and
 * not another, and a first-run flag whose whole job is to be false once.
 */
export const MACHINE_LOCAL_PREF_KEYS: readonly string[] = [
  "app:recentProjects",
  "manuscript:onboarding-done",
];

const TABLE = "prefs";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const cache = new Map<string, string>();
let hydrated = false;

/** True once the database is the store. Exposed for tests and diagnostics. */
export function prefsHydrated(): boolean {
  return hydrated;
}

// ─── localStorage, as the pre-hydration store and the migration source ───────
// Every access is guarded: vitest's node environment has no `localStorage` at
// all, and a browser in private mode can throw on write.

function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    // A preference that fails to persist is not worth failing the write over.
  }
}

function lsRemove(key: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch {
    /* see above */
  }
}

function lsKeys(): string[] {
  try {
    return typeof localStorage !== "undefined" ? Object.keys(localStorage) : [];
  } catch {
    return [];
  }
}

/** Whether `key` is one this module owns — the filter the migration runs on. */
export function isPrefKey(key: string): boolean {
  return (
    (PREF_KEYS as readonly string[]).includes(key) ||
    PREF_KEY_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length)
  );
}

// ─── The synchronous API every caller uses ───────────────────────────────────

export function readPref(key: string): string | null {
  return hydrated ? cache.get(key) ?? null : lsGet(key);
}

export function writePref(key: string, value: string): void {
  if (!hydrated) {
    lsSet(key, value);
    return;
  }
  cache.set(key, value);
  enqueue((db) =>
    db.execute(`INSERT OR REPLACE INTO ${TABLE} (key, value) VALUES (?, ?)`, [key, value]),
  );
}

export function deletePref(key: string): void {
  if (!hydrated) {
    lsRemove(key);
    return;
  }
  cache.delete(key);
  enqueue((db) => db.execute(`DELETE FROM ${TABLE} WHERE key = ?`, [key]));
}

/**
 * Drop every key under `prefix` whose suffix `keep` rejects.
 *
 * The collector for the per-project families above. Synchronous against the
 * cache — the caller's next read must not still see a key this just removed —
 * with the deletes persisted in the background like any other write.
 */
export function prunePrefsWithPrefix(prefix: string, keep: (suffix: string) => boolean): string[] {
  if (!hydrated) return [];
  const doomed = [...cache.keys()].filter((k) => k.startsWith(prefix) && !keep(k.slice(prefix.length)));
  for (const key of doomed) deletePref(key);
  return doomed;
}

/** Every stored key, for the config backup and for diagnostics. */
export function prefEntries(): [string, string][] {
  if (hydrated) return [...cache.entries()];
  return lsKeys()
    .filter(isPrefKey)
    .map((k) => [k, lsGet(k) ?? ""] as [string, string]);
}

/** The subset a config backup should carry (see `MACHINE_LOCAL_PREF_KEYS`). */
export function portablePrefEntries(): [string, string][] {
  return prefEntries().filter(
    ([k]) => !MACHINE_LOCAL_PREF_KEYS.includes(k) && !PREF_KEY_PREFIXES.some((p) => k.startsWith(p)),
  );
}

/**
 * Apply preferences from a config backup.
 *
 * Restricted to the portable set on the way in as well as on the way out: a
 * backup hand-edited (or written by a future version) to carry a
 * recent-projects list must not be able to plant paths from another machine.
 * Returns how many were applied. The caller reloads the UI afterwards — these
 * land in the store, not in the already-computed React state.
 */
export function applyPrefEntries(entries: [string, string][]): number {
  let applied = 0;
  for (const [key, value] of entries) {
    if (!isPrefKey(key) || MACHINE_LOCAL_PREF_KEYS.includes(key)) continue;
    if (PREF_KEY_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (typeof value !== "string") continue;
    writePref(key, value);
    applied++;
  }
  return applied;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

type Db = { execute: (sql: string, args?: unknown[]) => Promise<unknown> };

/**
 * Loaded lazily so that importing this module never pulls in the Tauri SQL
 * plugin. Half the test suite imports a store that reads a preference, and
 * none of them should have to mock a database to do it.
 */
async function openDb(): Promise<Db> {
  const { getGlobalDb } = await import("./project");
  const db = (await getGlobalDb()) as unknown as Db;
  await db.execute(`CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  return db;
}

/**
 * One chain for every write.
 *
 * Two `setPref` calls for the same key resolve in whatever order the driver
 * finishes them, and the loser wins the row — a slider dragged quickly is
 * enough to produce that. Serializing makes last-call-wins actually true.
 * Failures are logged and swallowed: the in-memory value is already correct,
 * so the cost is that one preference does not survive the restart, which is
 * not worth propagating into whatever the author was doing.
 */
let writeChain: Promise<void> = Promise.resolve();

function enqueue(op: (db: Db) => Promise<unknown>): void {
  writeChain = writeChain
    .then(async () => {
      await op(await openDb());
    })
    .catch((e) => console.warn("[prefs] could not persist a preference:", e));
}

/** Awaits the pending writes. For tests and for a clean shutdown. */
export async function flushPrefs(): Promise<void> {
  await writeChain;
}

// ─── Hydration ───────────────────────────────────────────────────────────────

/**
 * Load every preference into memory, migrating anything still in
 * `localStorage`, and make the database the store from here on.
 *
 * Called once from `main.tsx` before the modules that read preferences are
 * imported. Resolves either way: outside Tauri there is no database to read,
 * and inside Tauri a database that will not open leaves the app on
 * `localStorage` rather than starting with every preference at its default.
 */
export async function hydratePrefs(): Promise<void> {
  if (hydrated || !isTauri) return;
  let db: Db;
  try {
    db = await openDb();
    const rows = (await (db as unknown as {
      select: (sql: string) => Promise<{ key: string; value: string }[]>;
    }).select(`SELECT key, value FROM ${TABLE}`)) ?? [];
    for (const r of rows) {
      if (typeof r?.key === "string" && typeof r?.value === "string") cache.set(r.key, r.value);
    }
  } catch (e) {
    console.warn("[prefs] could not open the preference store; staying on localStorage:", e);
    return;
  }

  await migrateFromLocalStorage(db);
  hydrated = true;
  collectOrphanedProjectPrefs();
}

/**
 * Move preferences left behind by a build that stored them in the webview.
 *
 * Written to the database *before* being removed from `localStorage`, one key
 * at a time: the reverse order turns a failed write into a lost preference,
 * and a run interrupted halfway simply migrates the rest next launch. A key
 * already in the database wins — the database has been the store since the
 * moment this function first succeeded, so a `localStorage` copy that outlived
 * it is stale by definition.
 */
async function migrateFromLocalStorage(db: Db): Promise<void> {
  for (const key of lsKeys()) {
    if (!isPrefKey(key)) continue;
    const value = lsGet(key);
    if (value == null) continue;
    try {
      if (!cache.has(key)) {
        await db.execute(`INSERT OR REPLACE INTO ${TABLE} (key, value) VALUES (?, ?)`, [key, value]);
        cache.set(key, value);
      }
      lsRemove(key);
    } catch (e) {
      console.warn(`[prefs] could not migrate ${key}; leaving it in localStorage:`, e);
    }
  }
}

/**
 * Drop per-project preferences whose project is no longer in the recents list.
 *
 * `ai:pinnedLore:<absolute path>` accumulated one row per project ever opened
 * and nothing ever removed one — renaming or moving a folder orphaned its row
 * permanently, and even "clear recent projects" left them all behind. The
 * recents list is the app's own answer to "which projects still exist", so it
 * is the right thing to collect against; a project the author reopens later
 * simply starts with nothing pinned, which is what it would have shown anyway.
 */
function collectOrphanedProjectPrefs(): void {
  let live: string[] = [];
  try {
    const raw = JSON.parse(cache.get("app:recentProjects") ?? "[]") as unknown;
    if (Array.isArray(raw)) live = raw.filter((p): p is string => typeof p === "string");
  } catch {
    // An unreadable recents list is not grounds for deleting anything.
    return;
  }
  const alive = new Set(live);
  const dropped = prunePrefsWithPrefix(PINNED_LORE_PREFIX, (path) => alive.has(path));
  if (dropped.length) {
    console.info(`[prefs] released ${dropped.length} preference(s) for projects no longer listed.`);
  }
}

/** Test seam: forget everything and go back to the pre-hydration behaviour. */
export function resetPrefsForTest(): void {
  cache.clear();
  hydrated = false;
  writeChain = Promise.resolve();
}
