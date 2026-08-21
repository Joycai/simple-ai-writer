/**
 * Path arithmetic behind the sidebar's move/copy gestures (drag-and-drop and
 * the cut/copy/paste menu).
 *
 * Kept separate from the component because these are the parts that are easy
 * to get subtly wrong — a drop that quietly no-ops, a folder dragged into its
 * own subtree, a paste that overwrites a document — and the only way to cover
 * them is as pure functions. `dropRejection` is also what decides whether a
 * drop target lights up, so the highlight and the outcome cannot disagree.
 */

import { baseName, dirName, isStrictDescendant, normalizePathSegments } from "../paths";

/** The parent directory of a path. Re-exported under the sidebar's own name. */
export function parentDirOf(path: string): string {
  return dirName(path);
}

/** The final component of a path. */
export function baseNameOf(path: string): string {
  return baseName(path);
}

export type TransferMode = "move" | "copy";

/**
 * Why a transfer of `source` into `targetDir` cannot happen, or null when it
 * can.
 *
 * - `into-self` — the target is the folder itself or somewhere inside it.
 *   Renaming a folder under its own subtree strands it; copying recurses until
 *   the disk fills.
 * - `same-parent` — the source already lives there, so a move is a no-op. A
 *   *copy* into the same folder is meaningful (it duplicates), so this is only
 *   reported for moves.
 */
export function dropRejection(
  source: string,
  targetDir: string,
  mode: TransferMode,
): "into-self" | "same-parent" | null {
  const s = normalizePathSegments(source);
  const d = normalizePathSegments(targetDir);
  if (s === d || isStrictDescendant(s, d)) return "into-self";
  if (mode === "move" && normalizePathSegments(parentDirOf(source)) === d) return "same-parent";
  return null;
}

/**
 * Split a name into the stem that gets numbered and the suffix that must
 * survive. Directories have no extension — a folder called `v1.2` would
 * otherwise become `v1 (1).2`.
 */
function splitName(name: string, isDir: boolean): [string, string] {
  if (isDir) return [name, ""];
  const dot = name.lastIndexOf(".");
  // A leading dot is part of the name, not an extension (`.gitignore`).
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/**
 * Pick a free path for copying `name` into `dir`: the name as-is when nothing
 * is there, otherwise `名字 (1)`, `名字 (2)`, … before the extension.
 *
 * An existing ` (n)` suffix is replaced rather than stacked, so copying
 * `第一章 (1).md` again yields `第一章 (2).md` instead of `第一章 (1) (1).md`.
 *
 * `exists` is injected so the numbering can be tested without a filesystem;
 * callers pass `fileExists`. The result can still be stale by the time it is
 * written — the Rust side refuses an occupied destination, which is the check
 * that actually holds.
 */
export async function resolveCopyTarget(
  dir: string,
  name: string,
  isDir: boolean,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(`${dir}/${name}`))) return `${dir}/${name}`;

  const [rawStem, ext] = splitName(name, isDir);
  const stem = rawStem.replace(/ \(\d+\)$/, "");
  for (let n = 1; n <= 999; n++) {
    const candidate = `${dir}/${stem} (${n})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Too many copies of "${name}" already exist here.`);
}
