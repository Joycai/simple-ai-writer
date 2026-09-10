/**
 * Automatic pre-write backups for L1 ("write-auto") agent tools.
 *
 * The tiered write policy (docs/feature/agent/unified-agent-plan.md §3.2) lets the agent
 * apply lore/memory writes without a confirmation step — the safety valve is
 * that every overwrite first snapshots the original into
 * `.ai-writer/backups/`, the same flat directory LoreSplitModal already uses,
 * so one place holds everything recoverable.
 *
 * Naming: `agent-<epoch millis>-<flattened relative path>` — flattening keeps
 * the directory listable at a glance and avoids recreating the source tree.
 */

import { fileExists, makeDir, readFile, renamePath, writeFile } from "../fs/fileio";
import { baseName, projectRelative } from "../paths";
import type { ChangeRecord, StoredDiff } from "./events";
import { rewriteWindows } from "../diff/blocks";

/** The flat backup destination for `absPath`, shared by both backup flavours. */
async function backupDest(projectPath: string, absPath: string): Promise<string> {
  const backupDir = `${projectPath}/.ai-writer/backups`;
  await makeDir(backupDir);
  const rel = projectRelative(projectPath, absPath) || baseName(absPath) || "file";
  return `${backupDir}/agent-${Date.now()}-${rel.replace(/\//g, "-")}`;
}

/**
 * Snapshot `absPath` before an agent write, handing back both the backup's path
 * and the text that went into it. Null when the source doesn't exist yet
 * (creating a new file needs no backup).
 *
 * The text comes free: making the backup means reading the file. Callers that
 * want to record what the write changed (see {@link changeOf}) would otherwise
 * read the same bytes a second time to get the "before" they just copied.
 *
 * Throws on read/write failure — callers must treat a failed backup as a failed
 * write, never write anyway.
 */
export async function snapshotFile(
  projectPath: string,
  absPath: string,
): Promise<{ path: string; text: string } | null> {
  if (!(await fileExists(absPath))) return null;
  const text = await readFile(absPath);
  const dest = await backupDest(projectPath, absPath);
  await writeFile(dest, text);
  return { path: dest, text };
}

/** {@link snapshotFile} for the callers that only need to know where it went. */
export async function backupFile(projectPath: string, absPath: string): Promise<string | null> {
  return (await snapshotFile(projectPath, absPath))?.path ?? null;
}

/**
 * Longest text kept inline on a {@link ChangeRecord}, per side.
 *
 * Comfortably past a knowledge-base entry — an entity's index.md and a facet
 * both run to a few thousand characters at the outside — and short of the
 * things that also live in a project and would ride into the session database
 * on every write.
 *
 * Past it both sides are dropped rather than one: a record with only the new
 * text renders as "everything was added", which is a claim, not a shortage.
 */
export const CHANGE_TEXT_CHARS = 4_000;

/** Windows kept for a change whose texts were too long to keep. */
export const STORED_WINDOWS = 6;

/** Longest line kept inside a stored window. */
export const STORED_ROW_CHARS = 300;

/**
 * The change as windows, for a record that cannot keep its texts.
 *
 * What is dropped is what a folded window would not show anyway — each side's
 * lines past its first two — and each kept line is clipped, so the size is a
 * constant however long the chapter. Nothing is recorded when there is no
 * readable diff to keep (a refused one, or no change at all).
 */
function storedDiff(before?: string, after?: string): { diff?: StoredDiff } {
  if (before === undefined && after === undefined) return {};
  const model = rewriteWindows(before ?? "", after ?? "", { context: 1, maxWindows: STORED_WINDOWS });
  if (model.degraded || model.empty || model.windows.length === 0) return {};
  return {
    diff: {
      windows: model.windows.map((window) => ({
        ...window,
        rows: window.rows
          .filter((row) => !row.overflow)
          .map((row) =>
            row.text.length > STORED_ROW_CHARS
              ? { ...row, text: `${row.text.slice(0, STORED_ROW_CHARS)}…` }
              : row,
          ),
      })),
      hiddenTotal: model.hiddenTotal,
      summary: model.summary,
    },
  };
}

/**
 * A short, stable fingerprint of a text — change detection, not security.
 *
 * cyrb53 with the length in front: an undo asks "is this file still exactly
 * what that write left?", and has to be able to ask it about a file whose text
 * the record did not keep.
 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length.toString(36)}-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/**
 * Record what a write did to one file.
 *
 * `before` absent means the file did not exist (a create); `after` absent means
 * it no longer does (a delete). Both present is an update — including the case
 * where they are equal, which the caller is free to decide is worth recording
 * (a write that changed nothing is worth seeing at least once).
 */
export function changeOf(params: {
  projectPath: string;
  /** Absolute path of the file that changed. */
  path: string;
  entity?: string;
  before?: string;
  after?: string;
  backupPath?: string | null;
}): ChangeRecord {
  const { before, after } = params;
  const action = before === undefined ? "create" : after === undefined ? "delete" : "update";
  const fits =
    (before?.length ?? 0) <= CHANGE_TEXT_CHARS && (after?.length ?? 0) <= CHANGE_TEXT_CHARS;
  return {
    path: projectRelative(params.projectPath, params.path) || params.path,
    ...(params.entity ? { entity: params.entity } : {}),
    action,
    ...(fits && before !== undefined ? { before } : {}),
    ...(fits && after !== undefined ? { after } : {}),
    beforeChars: before?.length ?? 0,
    afterChars: after?.length ?? 0,
    ...(after !== undefined ? { afterHash: hashText(after) } : {}),
    ...(fits ? {} : storedDiff(before, after)),
    ...(params.backupPath ? { backupPath: params.backupPath } : {}),
  };
}

/**
 * {@link changeOf} for a write whose new text nobody holds — the lore layer
 * composes frontmatter and body itself, so the file that landed is the only
 * place the result exists.
 *
 * Reading it back is also the more honest answer, and for the same reason the
 * write receipts re-read rather than echo what was sent (`lineEcho`): the point
 * of a record is what is on disk, not what was meant to be. A file that cannot
 * be read back is recorded as an empty after rather than not at all — the write
 * happened either way, and a missing record would read as "nothing was written".
 */
export async function changeAfterWrite(params: {
  projectPath: string;
  path: string;
  entity?: string;
  before?: string;
  backupPath?: string | null;
}): Promise<ChangeRecord> {
  let after = "";
  try {
    after = await readFile(params.path);
  } catch {
    // Recorded as empty; see above.
  }
  return changeOf({ ...params, after });
}

/**
 * Back up `absPath` by MOVING it into `.ai-writer/backups/` — for binary files
 * (gallery images, avatars) that the text-only {@link backupFile} cannot
 * snapshot. The move IS both the backup and the removal, so there is no
 * half-deleted state; same naming as backupFile, same null-on-missing contract.
 */
export async function backupFileByMove(
  projectPath: string,
  absPath: string,
): Promise<string | null> {
  if (!(await fileExists(absPath))) return null;
  const dest = await backupDest(projectPath, absPath);
  await renamePath(absPath, dest);
  return dest;
}
