/**
 * 文库成员表 — which folders and documents the author has put in the library.
 *
 * The library used to be automatic discovery: every folder of the workspace
 * became a column, so a workspace with dozens of folders crushed the view into
 * slivers, and every stray `.md` counted as "chapter N" for 续写. Now the book
 * is what the author picks, persisted beside the order in
 * `.ai-writer/outline.json` (`BookSpine.members`):
 *
 * - a **folder** joins whole: its direct chapters and resources, including ones
 *   created later — minus any listed in `exclude`;
 * - a single **doc** can join on its own when its folder is not a member; its
 *   column then shows only the picked docs and no resources (`partial`).
 *
 * Membership is an overlay like the order: the filesystem stays the truth for
 * existence, entries pointing at nothing are ignored on read and pruned on
 * write. See docs/feature/library-plan.md → 第四期.
 */

import type { Chapter, Volume } from "./outline";

// outline.ts imports this module for resolveVolumes, so its naturalCompare
// can't be imported back as a value (the layering guard forbids the cycle).
// Same comparison: 第2章 < 第10章.
const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export interface LibraryMembers {
  /** Folder relPaths that joined whole (`""` = the project root's own files). */
  folders: string[];
  /** Doc relPaths picked one by one (their folder is not a whole member). */
  docs: string[];
  /** Doc relPaths left out of a whole-member folder. */
  exclude: string[];
}

export function emptyMembers(): LibraryMembers {
  return { folders: [], docs: [], exclude: [] };
}

/** The folder a relPath lives in — `""` for a file at the project root. */
export function parentRel(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function strings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === "string"))];
}

/** Read a persisted members object; null when it isn't one. */
export function parseMembers(raw: unknown): LibraryMembers | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return { folders: strings(o.folders), docs: strings(o.docs), exclude: strings(o.exclude) };
}

/**
 * Members for an `outline.json` written before the library was curated: the
 * volumes whose order list holds chapters — the ones the author was actually
 * arranging. Empty volumes and resource-only folders were recorded too (the
 * old save wrote every folder), but they were never chosen, so they stay out.
 */
export function inferLegacyMembers(order: Record<string, string[]>): LibraryMembers {
  const folders = Object.entries(order)
    .filter(([, chapters]) => Array.isArray(chapters) && chapters.length > 0)
    .map(([rel]) => rel);
  return { folders, docs: [], exclude: [] };
}

/**
 * Keep only the library's members out of every grouped volume. A whole-member
 * folder keeps its resources; a folder present only through picked docs is
 * `partial` and shows those docs alone.
 */
export function applyMembers(volumes: Volume[], members: LibraryMembers): Volume[] {
  const folders = new Set(members.folders);
  const docs = new Set(members.docs);
  const exclude = new Set(members.exclude);
  const out: Volume[] = [];
  for (const vol of volumes) {
    if (folders.has(vol.relPath)) {
      out.push({ ...vol, chapters: vol.chapters.filter((c) => !exclude.has(c.relPath)), partial: false });
      continue;
    }
    const picked = vol.chapters.filter((c) => docs.has(c.relPath));
    if (picked.length > 0) out.push({ ...vol, chapters: picked, resources: [], partial: true });
  }
  return out;
}

/** Whether a doc counts as a member under the current rules. */
export function isDocMember(members: LibraryMembers, docRel: string): boolean {
  if (members.folders.includes(parentRel(docRel))) return !members.exclude.includes(docRel);
  return members.docs.includes(docRel);
}

type FolderState = "all" | "some" | "none";

/**
 * A folder's checkbox: whole member with nothing excluded → all; whole member
 * with exclusions, or not a member but with picked docs → some; else none.
 */
export function folderState(members: LibraryMembers, vol: Volume): FolderState {
  const rels = new Set(vol.chapters.map((c) => c.relPath));
  if (members.folders.includes(vol.relPath)) {
    return members.exclude.some((r) => rels.has(r)) ? "some" : "all";
  }
  return members.docs.some((r) => rels.has(r)) ? "some" : "none";
}

const without = (list: string[], drop: (r: string) => boolean) => list.filter((r) => !drop(r));

/** Put a folder in whole, or take it out whole (its per-doc entries go too). */
export function setFolder(members: LibraryMembers, folderRel: string, on: boolean): LibraryMembers {
  const inFolder = (r: string) => parentRel(r) === folderRel;
  const folders = without(members.folders, (r) => r === folderRel);
  return {
    folders: on ? [...folders, folderRel] : folders,
    docs: without(members.docs, inFolder),
    exclude: without(members.exclude, inFolder),
  };
}

/** The folder checkbox: anything short of "all" becomes all; "all" becomes none. */
export function toggleFolder(members: LibraryMembers, vol: Volume): LibraryMembers {
  return setFolder(members, vol.relPath, folderState(members, vol) !== "all");
}

/** Several folders at once — the picker's 连同子文件夹. */
export function setFolders(members: LibraryMembers, folderRels: string[], on: boolean): LibraryMembers {
  return folderRels.reduce((m, rel) => setFolder(m, rel, on), members);
}

/** Add one doc: un-exclude it inside a whole member, else pick it. */
export function addDoc(members: LibraryMembers, docRel: string): LibraryMembers {
  if (members.folders.includes(parentRel(docRel))) {
    return { ...members, exclude: without(members.exclude, (r) => r === docRel) };
  }
  if (members.docs.includes(docRel)) return members;
  return { ...members, docs: [...members.docs, docRel] };
}

/** Take one doc out: exclude it from a whole member, else unpick it. */
export function removeDoc(members: LibraryMembers, docRel: string): LibraryMembers {
  if (members.folders.includes(parentRel(docRel))) {
    if (members.exclude.includes(docRel)) return members;
    return { ...members, exclude: [...members.exclude, docRel] };
  }
  return { ...members, docs: without(members.docs, (r) => r === docRel) };
}

export function toggleDoc(members: LibraryMembers, docRel: string): LibraryMembers {
  return isDocMember(members, docRel) ? removeDoc(members, docRel) : addDoc(members, docRel);
}

/**
 * Drop entries that point at nothing in the current tree, and entries that
 * contradict each other (a picked doc inside a whole member, an exclusion
 * outside one). Called before persisting, never on read.
 */
export function pruneMembers(members: LibraryMembers, allVolumes: Volume[]): LibraryMembers {
  const folderRels = new Set(allVolumes.map((v) => v.relPath));
  const docRels = new Set(allVolumes.flatMap((v) => v.chapters.map((c) => c.relPath)));
  const folders = members.folders.filter((r) => folderRels.has(r));
  const whole = new Set(folders);
  return {
    folders,
    docs: members.docs.filter((r) => docRels.has(r) && !whole.has(parentRel(r))),
    exclude: members.exclude.filter((r) => docRels.has(r) && whole.has(parentRel(r))),
  };
}

export function membersEqual(a: LibraryMembers, b: LibraryMembers): boolean {
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((r) => y.includes(r));
  return same(a.folders, b.folders) && same(a.docs, b.docs) && same(a.exclude, b.exclude);
}

// ─── Picker tree ─────────────────────────────────────────────────────────────

export interface PickerNode {
  vol: Volume;
  /** Direct chapter files, natural-sorted. */
  docs: Chapter[];
  /** Subfolders, natural-sorted. */
  children: PickerNode[];
}

/**
 * Nest the flat volume list for the picker. The project root (relPath `""`)
 * is its own first row holding only root-level files; top-level folders sit
 * beside it rather than under it, so the whole tree isn't one indent deep.
 */
export function buildPickerTree(volumes: Volume[]): PickerNode[] {
  const nodes = new Map<string, PickerNode>();
  for (const vol of volumes) {
    nodes.set(vol.relPath, {
      vol,
      docs: [...vol.chapters].sort((a, b) => naturalCompare(a.name, b.name)),
      children: [],
    });
  }
  const top: PickerNode[] = [];
  for (const vol of volumes) {
    const node = nodes.get(vol.relPath)!;
    const parent = vol.relPath === "" ? undefined : nodes.get(parentRel(vol.relPath));
    if (parent && parent.vol.relPath !== "") parent.children.push(node);
    else top.push(node);
  }
  const byName = (a: PickerNode, b: PickerNode) => naturalCompare(a.vol.name, b.vol.name);
  const sortDeep = (list: PickerNode[]) => {
    list.sort(byName);
    for (const n of list) sortDeep(n.children);
  };
  sortDeep(top);
  // The root row stays first whatever its name sorts as.
  const rootIdx = top.findIndex((n) => n.vol.relPath === "");
  if (rootIdx > 0) top.unshift(...top.splice(rootIdx, 1));
  return top;
}

/**
 * Narrow the tree to a case-insensitive name query: a folder whose name
 * matches keeps everything under it; otherwise it survives only through
 * matching docs or descendants.
 */
export function filterPickerTree(nodes: PickerNode[], query: string): PickerNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const hit = (name: string) => name.toLowerCase().includes(q);
  const walk = (list: PickerNode[]): PickerNode[] => {
    const out: PickerNode[] = [];
    for (const n of list) {
      if (hit(n.vol.name)) { out.push(n); continue; }
      const docs = n.docs.filter((d) => hit(d.name));
      const children = walk(n.children);
      if (docs.length > 0 || children.length > 0) out.push({ ...n, docs, children });
    }
    return out;
  };
  return walk(nodes);
}

/** A folder's relPath and every descendant folder's, depth-first. */
export function folderSubtree(node: PickerNode): string[] {
  return [node.vol.relPath, ...node.children.flatMap(folderSubtree)];
}

/** Whether the node or any folder below it holds a member (for default expansion). */
export function subtreeHasMembers(members: LibraryMembers, node: PickerNode): boolean {
  return folderState(members, node.vol) !== "none" || node.children.some((c) => subtreeHasMembers(members, c));
}
