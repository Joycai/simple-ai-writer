/**
 * Whole-project backup and restore.
 *
 * The lore bundle (see lib/lore/transfer) carries the knowledge base and
 * nothing else, which is the right scope for "send my setting to someone" and
 * the wrong one for "move to a new machine": `profile.json`, `outline.json`,
 * the rolling memory under `.ai-writer/memory/` and the illustrations in each
 * document's `assets/` folder are all *inputs the model sees*, so a project
 * missing them behaves differently with nothing on screen saying why. This
 * module packs the project as it actually is.
 *
 * Note on `.ai-writer/tasks/`: task workspace state and notes are intentionally
 * INCLUDED (not in PROJECT_BACKUP_EXCLUDES) because they represent recoverable
 * long-running task and subagent state that belongs with the project.
 *
 * What it deliberately leaves out:
 *   - `.ai-writer/backups/` — pre-write copies, recoverable state for *this*
 *     machine, and easily larger than the project itself.
 *   - `.ai-writer/tmp/`, `.ai-writer/lore-import-tmp/`, `.ai-writer/sync-tmp/`
 *     — scratch, and the staging dirs may hold a half-finished import or a
 *     knowledge-base sync interrupted mid-unpack.
 *   - `project.db-wal` / `-shm` — SQLite sidecars that mean nothing beside a
 *     checkpointed database (see `checkpointDb`).
 *   - `.git`, `node_modules` — present only if the author keeps the project
 *     inside a repo, and never theirs to restore.
 *
 * Also *not* included: the app-level `config.db` (providers, models, prompts)
 * and the API keys in the OS keyring. Those are not project data — they belong
 * to the installation, and Settings → 常规 exports them separately. The restore
 * UI says so rather than letting the author discover it on the new machine.
 */

import { getVersion } from "@tauri-apps/api/app";
import { readDir } from "./fileio";
import { zipExportDialog, zipImportDialog } from "./transfer";
import { activeWorkspace } from "../profile/active";
import { getDb, openProjectFolder } from "../project";
import { baseName } from "../paths";

export const PROJECT_BUNDLE_KIND = "ai-writer-project-bundle";
export const PROJECT_BUNDLE_VERSION = 1;

/** The zip subtree the payload is stored under. */
const PAYLOAD_PREFIX = "project";

/** Paths relative to the project root that never belong in a backup. */
export const PROJECT_BACKUP_EXCLUDES = [
  ".ai-writer/backups",
  ".ai-writer/tmp",
  ".ai-writer/lore-import-tmp",
  ".ai-writer/sync-tmp",
  ".ai-writer/project.db-wal",
  ".ai-writer/project.db-shm",
  ".git",
  "node_modules",
];

export interface ProjectBundleManifest {
  kind: typeof PROJECT_BUNDLE_KIND;
  version: number;
  exportedAt: string;
  appVersion: string;
  /** The source folder's own name, so a restore can say which project this is. */
  projectName: string;
  profileId: string;
}

function folderName(path: string): string {
  return baseName(path) || "project";
}

/**
 * Fold the write-ahead log back into `project.db` before it is archived.
 *
 * sqlx opens SQLite in WAL mode, so recent writes — the token-usage rows from
 * the session that is about to be backed up, among others — live in
 * `project.db-wal` and not yet in the database file. Copying `project.db`
 * alone would silently restore an older database; copying the `-wal` alongside
 * it would restore a pair that may not match. Checkpointing makes the single
 * file complete, which is why the sidecars are on the exclude list.
 *
 * `wal_checkpoint` returns a row, so it goes through `select`, not `execute`.
 * Best-effort: a checkpoint the database refuses (another window holding a
 * read) costs at worst the newest rows, and is not a reason to refuse to back
 * the project up at all.
 */
async function checkpointDb(projectPath: string): Promise<void> {
  try {
    const db = await getDb(projectPath);
    await db.select("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    console.warn("[projectBackup] could not checkpoint the project database:", e);
  }
}

async function appVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return ""; // browser dev environment — the manifest is still valid without it
  }
}

/**
 * Export the whole project as a zip via the native save dialog. Returns the
 * saved path, or null when the user cancelled.
 *
 * The caller is responsible for flushing unsaved editor state first — this
 * module reads the disk, and only the stores know what is still in memory.
 */
export async function exportProjectBundle(projectPath: string): Promise<string | null> {
  await checkpointDb(projectPath);

  const manifest: ProjectBundleManifest = {
    kind: PROJECT_BUNDLE_KIND,
    version: PROJECT_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: await appVersion(),
    projectName: folderName(projectPath),
    // Informational only (shown when restoring). Packs are equal toggles, so
    // the stamp is the whole enabled list rather than a single profile.
    profileId: activeWorkspace().enabled.map((p) => p.id).join("+") || "none",
  };

  const date = new Date().toISOString().slice(0, 10);
  return zipExportDialog(
    projectPath,
    PAYLOAD_PREFIX,
    JSON.stringify(manifest, null, 2),
    `${manifest.projectName}-backup-${date}.zip`,
    PROJECT_BACKUP_EXCLUDES,
  );
}

export interface RestoredProject {
  /** Where the project was unpacked — hand this to `openProject`. */
  path: string;
  manifest: ProjectBundleManifest | null;
  fileCount: number;
}

/**
 * Restore a backup into a folder the user picks. Returns null when either
 * dialog was cancelled.
 *
 * Unlike the lore import there is no staging step and no conflict strategy,
 * because there is nothing to conflict with: the destination must be an empty
 * folder. Restoring *over* a project is the one shape of this operation that
 * can destroy work — half the old tree surviving underneath a restored one is
 * worse than either — and "pick an empty folder, then open it" is a flow the
 * author can reason about. Moving the result to where they actually want it is
 * their file manager's job, not ours.
 *
 * Throws `Error("dest-not-empty")` when the chosen folder has anything in it,
 * and `Error("empty-bundle")` when a valid-looking bundle carried no files.
 * A zip whose manifest is not a project bundle is refused by the Rust side
 * before a single file is written.
 */
export async function restoreProjectBundle(): Promise<RestoredProject | null> {
  // Picking through the Rust dialog is also what registers the folder as an
  // allowed fs root — the scoped commands reject it otherwise.
  const dest = await openProjectFolder();
  if (!dest) return null;

  const existing = await readDir(dest);
  if (existing.length > 0) throw new Error("dest-not-empty");

  const result = await zipImportDialog(dest, PAYLOAD_PREFIX, PROJECT_BUNDLE_KIND);
  if (!result) return null;
  if (result.file_count === 0) throw new Error("empty-bundle");

  return { path: dest, manifest: parseManifest(result.manifest), fileCount: result.file_count };
}

/**
 * The manifest is informational here: the Rust side already refused anything
 * that does not declare our `kind`, so an unreadable one costs the restore
 * summary its detail, not its correctness.
 */
function parseManifest(raw: string | null): ProjectBundleManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProjectBundleManifest;
    return parsed && parsed.kind === PROJECT_BUNDLE_KIND ? parsed : null;
  } catch {
    return null;
  }
}
