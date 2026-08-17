/**
 * The sidebar's multi-selection arithmetic.
 *
 * Sits beside ./moveCopy for the same reason: these are the parts that are
 * easy to get subtly wrong — a shift-range that walks collapsed folders, a
 * multi-drag that moves a folder *and* a file inside it (the second move then
 * targets a path that no longer exists) — and the only way to cover them is as
 * pure functions over the tree the store already holds.
 *
 * Everything here works on a structural shape rather than `FileNode` so the
 * filesystem layer stays independent of `lib/project`.
 */

import { isStrictDescendant } from "../paths";

/** The shape these helpers need from a file-tree node. */
export interface TreeNodeLike {
  path: string;
  is_dir: boolean;
  children?: TreeNodeLike[] | null;
}

/** One row as the sidebar actually renders it, in top-to-bottom order. */
export interface TreeRow {
  path: string;
  isDir: boolean;
}

/**
 * Whether a folder row is open, given whatever `expandedDirs` holds for it.
 *
 * The single definition of the tree's default: top-level folders start open,
 * deeper ones closed, and an explicit entry always wins. FileTree's `TreeNode`
 * reads it too, so the rendered tree and the flattened one below cannot
 * disagree about which rows exist.
 */
export function isDirOpen(stored: boolean | undefined, depth: number): boolean {
  return stored ?? depth === 0;
}

/**
 * The rows currently on screen, in visual order — what a shift-click range has
 * to be computed over. A collapsed folder contributes its own row and none of
 * its children, exactly as the author sees it.
 */
export function flattenVisible(
  nodes: readonly TreeNodeLike[],
  expandedDirs: Record<string, boolean>,
  depth = 0,
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes) {
    rows.push({ path: node.path, isDir: node.is_dir });
    if (node.is_dir && node.children && isDirOpen(expandedDirs[node.path], depth)) {
      rows.push(...flattenVisible(node.children, expandedDirs, depth + 1));
    }
  }
  return rows;
}

/**
 * The paths from `anchor` to `focus` inclusive, in visual order — a shift-click
 * range. Either endpoint being off-screen (its folder was collapsed since the
 * anchor was set) degrades to just the clicked row rather than selecting a
 * span the author cannot see.
 */
export function rangeBetween(
  rows: readonly TreeRow[],
  anchor: string,
  focus: string,
): string[] {
  const a = rows.findIndex((r) => r.path === anchor);
  const b = rows.findIndex((r) => r.path === focus);
  if (a < 0 || b < 0) return b < 0 ? [] : [focus];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return rows.slice(from, to + 1).map((r) => r.path);
}

/**
 * Drop any entry that already travels inside another one.
 *
 * Selecting a folder *and* something in it is easy to do with shift-click, and
 * transferring both would move the folder first and then look for a child at a
 * path that no longer exists — a failure the author caused by clicking
 * normally. The folder carries its contents, so the descendants are redundant,
 * not a conflict.
 */
export function pruneNested<T extends { path: string }>(sources: readonly T[]): T[] {
  return sources.filter(
    (s) => !sources.some((other) => other !== s && isStrictDescendant(other.path, s.path)),
  );
}

/**
 * Keep only the selected paths that still exist in the tree.
 *
 * A selection outlives the operation performed on it — a move rewrites every
 * selected path, a delete removes them — and a stale entry would silently
 * widen the *next* gesture to a file that is no longer there.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  rows: readonly TreeRow[],
): Set<string> {
  const live = new Set(rows.map((r) => r.path));
  const next = new Set<string>();
  for (const path of selected) if (live.has(path)) next.add(path);
  return next;
}

/**
 * Every row of the tree, expanded or not — the lookup that turns a set of
 * selected paths back into `{path, isDir}` pairs a transfer can act on.
 */
export function allRows(nodes: readonly TreeNodeLike[]): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes) {
    rows.push({ path: node.path, isDir: node.is_dir });
    if (node.children) rows.push(...allRows(node.children));
  }
  return rows;
}
