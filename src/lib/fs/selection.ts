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
 * How many folders the author can see are open — the number 「已折叠 N 个分组」
 * reports.
 *
 * Counts what actually changes on screen, so it recurses only into folders that
 * are themselves open (same reason as `hasOpenDir`): a folder left open inside
 * a collapsed one flips no chevron the author is looking at, and counting it
 * would make the sentence say more than happened.
 */
export function openDirCount(
  nodes: readonly TreeNodeLike[],
  expandedDirs: Record<string, boolean>,
  depth = 0,
): number {
  let n = 0;
  for (const node of nodes) {
    if (!node.is_dir || !isDirOpen(expandedDirs[node.path], depth)) continue;
    n += 1;
    if (node.children) n += openDirCount(node.children, expandedDirs, depth + 1);
  }
  return n;
}

/**
 * The folders on the way down to `path`, outermost first — what has to be
 * opened for a row to become visible again (「定位当前文档」).
 *
 * Returns nothing when the path is not in the tree, so a stale active file
 * cannot make the caller expand a chain that leads nowhere.
 */
export function ancestorsOf(nodes: readonly TreeNodeLike[], path: string): string[] {
  const walk = (list: readonly TreeNodeLike[], trail: string[]): string[] | null => {
    for (const node of list) {
      if (node.path === path) return trail;
      if (node.is_dir && node.children) {
        const hit = walk(node.children, [...trail, node.path]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(nodes, []) ?? [];
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

/**
 * Every folder in the tree, explicitly closed — what 「全部折叠」 has to write.
 *
 * It cannot be done by *clearing* `expandedDirs`: the default is
 * `stored ?? depth === 0`, so clearing the table is "back to the default", and
 * the default is not all-collapsed — every top-level folder would spring open
 * again. The already-collapsed deep folders get a key too, which costs nothing
 * and keeps the result independent of what was open when it was called.
 */
export function collapseAllMap(nodes: readonly TreeNodeLike[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  const walk = (list: readonly TreeNodeLike[]) => {
    for (const node of list) {
      if (!node.is_dir) continue;
      map[node.path] = false;
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return map;
}

/**
 * Every folder in the tree, explicitly open — the reverse of `collapseAllMap`,
 * and it cannot clear the table either: clearing would drop *deep* folders
 * back to their closed default, which is the opposite of what was asked.
 */
export function expandAllMap(nodes: readonly TreeNodeLike[]): Record<string, boolean> {
  const map = collapseAllMap(nodes);
  for (const path of Object.keys(map)) map[path] = true;
  return map;
}

/**
 * Is any folder the author can currently see still open — i.e. does
 * 「全部折叠」 have anything left to do.
 *
 * **Only the top level is examined, and that is not a shortcut.** A folder is
 * on screen only if every ancestor is open, so whenever a visible open folder
 * exists, its outermost ancestor is itself an open top-level folder — the two
 * questions have the same answer. Walking deeper would additionally count a
 * folder left open inside a collapsed ancestor, which is *not* on screen: the
 * button would be live and its click would change nothing the author can see.
 * That stale `true` is harmless — it becomes visible, and countable, the moment
 * the ancestor is reopened.
 *
 * Goes through `isDirOpen` rather than reading the table: a top-level folder
 * with no entry yet *is* open, and a check that missed that would leave the
 * button disabled on a project that was just opened.
 */
export function hasOpenDir(
  nodes: readonly TreeNodeLike[],
  expandedDirs: Record<string, boolean>,
): boolean {
  return nodes.some((node) => node.is_dir && isDirOpen(expandedDirs[node.path], 0));
}
