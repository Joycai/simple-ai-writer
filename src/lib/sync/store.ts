/**
 * `.ai-writer/sync.json` — which knowledge base this project is bound to, and
 * the hash snapshot of the last completed sync.
 *
 * Modelled on `lib/profile/store.ts`, including the part that matters most:
 * **never throw**. This is read on the project-open path, and a file that is
 * missing, truncated or hand-edited into nonsense must degrade to "not bound"
 * rather than stop the author opening their project. The cost of degrading is
 * one re-bind; the cost of throwing is a project that will not open.
 *
 * A damaged *snapshot* degrades further but still safely: with no snapshot the
 * planner reports every difference as a two-sided conflict (`./plan`), which is
 * noisy but never silently destructive.
 */

import { fileExists, makeDir, readFile, removeFile, writeFile } from "../fs/fileio";
import { normalizeServerUrl } from "./config";
import type { HashMap, SyncBinding } from "./model";
import { dirName, toPosixPath } from "../paths";

const FILE_VERSION = 1;

/** Scratch directory the sync engine unpacks into; never part of a backup. */
export const SYNC_STAGING_DIR = "sync-tmp";

function syncPath(projectPath: string): string {
  return `${toPosixPath(projectPath)}/.ai-writer/sync.json`;
}

export function syncStagingPath(projectPath: string): string {
  return `${toPosixPath(projectPath)}/.ai-writer/${SYNC_STAGING_DIR}`;
}

interface SyncFile {
  version: number;
  serverUrl: string;
  kbId: string;
  kbName: string;
  lastSyncAt: string | null;
  snapshot: Record<string, string>;
}

/**
 * Validate a parsed file into a binding, or null.
 *
 * Field by field rather than a cast: this file is small enough to hand-edit and
 * old enough (from the next release onwards) to have been written by a build
 * that disagrees about its shape. A `kbId` that is not a string would otherwise
 * reach the URL builder and produce requests against `undefined`.
 */
function parseSyncFile(raw: unknown): SyncBinding | null {
  if (!raw || typeof raw !== "object") return null;
  const file = raw as Partial<SyncFile>;
  if (typeof file.serverUrl !== "string" || !file.serverUrl.trim()) return null;
  if (typeof file.kbId !== "string" || !file.kbId.trim()) return null;

  // Only string→string pairs survive. A half-written snapshot is worth keeping
  // for the entries it does describe: those entries still get a real three-way
  // answer, and the rest degrade to "conflict", which is the safe direction.
  const snapshot: Record<string, string> = {};
  if (file.snapshot && typeof file.snapshot === "object") {
    for (const [path, hash] of Object.entries(file.snapshot)) {
      if (typeof path === "string" && typeof hash === "string" && path && hash) {
        snapshot[path] = hash;
      }
    }
  }

  return {
    serverUrl: normalizeServerUrl(file.serverUrl),
    kbId: file.kbId.trim(),
    kbName: typeof file.kbName === "string" ? file.kbName : file.kbId.trim(),
    lastSyncAt: typeof file.lastSyncAt === "string" ? file.lastSyncAt : null,
    snapshot,
  };
}

/** The project's binding, or null when it has none. Never throws. */
export async function loadBinding(projectPath: string): Promise<SyncBinding | null> {
  const path = syncPath(projectPath);
  try {
    if (!(await fileExists(path))) return null;
    return parseSyncFile(JSON.parse(await readFile(path)));
  } catch (err) {
    console.warn(`[sync] could not read ${path}; treating the project as unbound:`, err);
    return null;
  }
}

export async function saveBinding(projectPath: string, binding: SyncBinding): Promise<void> {
  const path = syncPath(projectPath);
  await makeDir(dirName(path));
  const file: SyncFile = {
    version: FILE_VERSION,
    serverUrl: normalizeServerUrl(binding.serverUrl),
    kbId: binding.kbId,
    kbName: binding.kbName,
    lastSyncAt: binding.lastSyncAt,
    snapshot: { ...binding.snapshot },
  };
  await writeFile(path, JSON.stringify(file, null, 2));
}

/** Forget the binding. The token stays in the keyring — it belongs to the
 *  server, not to this project, and other projects may still be using it. */
export async function clearBinding(projectPath: string): Promise<void> {
  try {
    await removeFile(syncPath(projectPath));
  } catch {
    // Already gone, which is the state the caller wanted.
  }
}

/**
 * The snapshot after a sync in which `succeeded` entries reached the state
 * `hashes` describes.
 *
 * Applied per entry rather than wholesale because a sync can fail partway: the
 * entries that did land are genuinely in sync and must be recorded as such, or
 * the next plan would flag every one of them as a two-sided conflict. An entry
 * absent from `hashes` was deleted on both sides and leaves the snapshot.
 */
export function advanceSnapshot(
  previous: HashMap,
  hashes: HashMap,
  succeeded: readonly string[],
): HashMap {
  const next: Record<string, string> = { ...previous };
  for (const path of succeeded) {
    const hash = hashes[path];
    if (hash) next[path] = hash;
    else delete next[path];
  }
  return next;
}
