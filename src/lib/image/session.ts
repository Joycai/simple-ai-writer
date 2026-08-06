/**
 * Scratch storage for an image session, and the on-disk record of what was
 * kept.
 *
 * Generated images do not live in the store as base64. A conversational edit
 * run produces a whole tree of candidates, and holding all of them as data
 * URLs means tens of megabytes of strings in React state — so every result is
 * written to a scratch file immediately and the session carries paths, which
 * the existing `useImageDataUrl` hook renders exactly like a gallery image.
 */

import { fileExists, makeDir, readDir, readFile, removeDir, writeBinaryFile, writeFile } from "../fs/fileio";
import { dataUrlToBytes } from "../fs/images";

/** Scratch root. Under `.ai-writer/` so it travels with the project and is scoped. */
const SCRATCH_ROOT = ".ai-writer/tmp/imagegen";

/** Where one session's candidates live. */
export function sessionDir(projectPath: string, sessionId: string): string {
  return `${projectPath}/${SCRATCH_ROOT}/${sessionId}`;
}

/**
 * Write one turn's candidates to the session's scratch dir, returning their
 * paths in the order given.
 */
export async function writeCandidates(
  projectPath: string,
  sessionId: string,
  turnId: string,
  images: { dataUrl: string }[],
): Promise<string[]> {
  const dir = sessionDir(projectPath, sessionId);
  await makeDir(dir);
  const paths: string[] = [];
  for (const [i, img] of images.entries()) {
    const { bytes, ext } = dataUrlToBytes(img.dataUrl);
    const path = `${dir}/${turnId}-${i}.${ext}`;
    await writeBinaryFile(path, bytes);
    paths.push(path);
  }
  return paths;
}

/** Drop a finished session's scratch files. Best-effort: an orphan is harmless. */
export async function discardSession(projectPath: string, sessionId: string): Promise<void> {
  try {
    const dir = sessionDir(projectPath, sessionId);
    if (await fileExists(dir)) await removeDir(dir);
  } catch {
    // Swept on the next open (see sweepScratch).
  }
}

/**
 * Remove scratch dirs left behind by a previous run — a crash, or a window
 * closed mid-session, never reaches `discardSession`. Called when a session
 * starts, so the directory can't grow without bound across launches.
 * `keepSessionId` spares the session about to begin.
 */
export async function sweepScratch(projectPath: string, keepSessionId: string): Promise<void> {
  try {
    const root = `${projectPath}/${SCRATCH_ROOT}`;
    if (!(await fileExists(root))) return;
    for (const entry of await readDir(root)) {
      if (entry.isDirectory && entry.name !== keepSessionId) {
        try { await removeDir(entry.path); } catch { /* next sweep gets it */ }
      }
    }
  } catch {
    // Never block a generation on housekeeping.
  }
}

// ─── Generation record ───────────────────────────────────────────────────────

/** What produced one image that the author decided to keep. */
export interface ImageRecord {
  /** Path of the saved image, relative to the project root. */
  path: string;
  /** The prompt actually sent for this image. */
  prompt: string;
  /** The edit instructions applied on top of the root prompt, oldest first. */
  edits: string[];
  model: string;
  size?: string;
  aspect?: string;
  /** Whether this came out of an edit call or a regeneration standing in for one. */
  degraded?: boolean;
  createdAt: number;
  costUsd: number;
}

const RECORD_FILE = ".ai-writer/imagegen.json";

/**
 * Append one kept image to the project's generation record.
 *
 * A side-log, deliberately not part of `images.md`: the gallery format stays
 * exactly as it was, while an author can still ask "how did this picture come
 * about" and an edit chain can be resumed after the app restarts.
 */
export async function recordGeneration(projectPath: string, record: ImageRecord): Promise<void> {
  if (!projectPath) return;
  try {
    const path = `${projectPath}/${RECORD_FILE}`;
    let list: ImageRecord[] = [];
    if (await fileExists(path)) {
      try {
        const parsed = JSON.parse(await readFile(path)) as unknown;
        if (Array.isArray(parsed)) list = parsed as ImageRecord[];
      } catch {
        // A corrupt log is not worth losing the image over — start a new one.
      }
    }
    list.push(record);
    await writeFile(path, JSON.stringify(list, null, 2));
  } catch {
    // Bookkeeping must never fail a save that already landed on disk.
  }
}

/** Read the whole generation record. Missing or corrupt file ⇒ empty list. */
export async function readGenerationRecords(projectPath: string): Promise<ImageRecord[]> {
  try {
    const path = `${projectPath}/${RECORD_FILE}`;
    if (!(await fileExists(path))) return [];
    const parsed = JSON.parse(await readFile(path)) as unknown;
    return Array.isArray(parsed) ? (parsed as ImageRecord[]) : [];
  } catch {
    return [];
  }
}
