/**
 * What one file-tree row *is* — the pure half of 设计稿 17's row anatomy.
 *
 * The panel has a single accent colour, and 设计稿 17 spends it on "the open
 * document" and "the selection". File kinds therefore get no colour of their
 * own: they are told apart by an icon and by the right-hand column, and by two
 * levels of grey — things the author writes (`.md` `.txt` `.html`) against
 * things that merely live in the folder (imported originals, pictures, an
 * `assets/` group). Everything here is derived from the node's own name and
 * its siblings; nothing reads a file, and nothing measures.
 */

import { ASSETS_DIR, safeAssetName } from "../image/assets";

/** The six row kinds 设计稿 17 draws. */
export type RowKind =
  /** A folder the author made. */
  | "folder"
  /** One document's illustration folder — `assets/<文档名>/`. */
  | "assets"
  /** Something the author writes: .md / .txt. */
  | "doc"
  /** An AI-authored deliverable: .html. */
  | "deliverable"
  /** A single picture. */
  | "image"
  /** An imported original (.docx/.pdf/.pptx/.xlsx) or anything unrecognised. */
  | "original";

const DOC_EXTS = new Set(["md", "markdown", "txt"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "heif"]);
const HTML_EXTS = new Set(["html", "htm"]);

/** Lower-case extension without the dot, or "" when the name carries none. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Which of the six kinds this row is.
 *
 * `parentName` decides `assets` — a folder is an illustration group because of
 * *where* it sits, not what it is called (the author is free to have a folder
 * called 插图 that is an ordinary group).
 */
export function rowKind(name: string, isDir: boolean, parentName: string | null): RowKind {
  if (isDir) return parentName === ASSETS_DIR ? "assets" : "folder";
  const ext = extOf(name);
  if (DOC_EXTS.has(ext)) return "doc";
  if (HTML_EXTS.has(ext)) return "deliverable";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "original";
}

/**
 * The two greys. `true` = 「in this folder, but not the thing you are writing」
 * — one step back, so a scan for the next chapter isn't slowed by the props.
 */
export function isSecondary(kind: RowKind): boolean {
  return kind === "original" || kind === "image" || kind === "assets";
}

/**
 * The right column's text for a file row: the extension in caps, or `null` for
 * a document (`.md` is the default here — its suffix is already hidden from
 * the name, so printing MD would put it back).
 *
 * One column, two meanings: folders show their document count instead. Neither
 * is ever hidden — 设计稿 17 §2e removed the hover buttons precisely so this
 * column never has to yield.
 */
export function extLabel(name: string, kind: RowKind): string | null {
  if (kind === "assets" || kind === "folder") return null;
  const ext = extOf(name);
  if (!ext || ext === "md" || ext === "markdown") return null;
  return ext.toUpperCase();
}

/**
 * Do the documents beside an `assets/` folder still include the one this group
 * belongs to?
 *
 * A group is named after its document (`safeAssetName(stem)`), and the links
 * inside that document point at the folder by name — so renaming either one
 * breaks every picture in it, silently, and the author has no reason to open
 * the document again to find out. `null` = not an assets group at all.
 */
export function assetsGroupOrphaned(
  groupName: string,
  siblingDocNames: readonly string[],
): boolean {
  const groups = new Set(
    siblingDocNames.map((n) => {
      const dot = n.lastIndexOf(".");
      return safeAssetName(dot > 0 ? n.slice(0, dot) : n);
    }),
  );
  return !groups.has(groupName);
}

/** The shape `orphanedAssetGroups` needs from a node. */
export interface NamedNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: NamedNode[] | null;
}

/**
 * Every `assets/<group>/` folder whose document is no longer beside it.
 *
 * One walk for the whole tree rather than a lookup per row: the sibling list a
 * group is checked against is the one the walk is already standing in. Nothing
 * is read from disk — a folder name and its neighbours' names is the whole
 * input.
 */
export function orphanedAssetGroups(nodes: readonly NamedNode[]): Set<string> {
  const orphans = new Set<string>();
  const walk = (list: readonly NamedNode[]) => {
    const docNames = list.filter((n) => !n.is_dir).map((n) => n.name);
    for (const node of list) {
      if (!node.is_dir) continue;
      if (node.name === ASSETS_DIR) {
        for (const group of node.children ?? []) {
          if (group.is_dir && assetsGroupOrphaned(group.name, docNames)) orphans.add(group.path);
        }
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return orphans;
}

/**
 * The documents an orphaned `assets/<group>/` could be re-attached to.
 *
 * Two filters, and the second one is the point: a candidate whose own group
 * folder already sits in the same `assets/` is left out, so the repair can
 * never be asked to merge two galleries — a refusal `relinkAssetGroup` would
 * have to make anyway, made here instead by not offering the choice.
 *
 * Only `.md` files: those are what `ownsAssets` keeps illustrations for, so
 * re-attaching to anything else would rename a folder and rewrite nothing.
 * Same walk shape as {@link orphanedAssetGroups} — nothing reads the disk.
 */
export function relinkCandidates(
  nodes: readonly NamedNode[],
  groupPath: string,
): NamedNode[] {
  let found: NamedNode[] = [];
  const walk = (list: readonly NamedNode[]) => {
    for (const node of list) {
      if (!node.is_dir) continue;
      if (node.name === ASSETS_DIR && (node.children ?? []).some((g) => g.path === groupPath)) {
        const taken = new Set((node.children ?? []).filter((g) => g.is_dir).map((g) => g.name));
        found = list.filter((n) => {
          if (n.is_dir || !/\.md$/i.test(n.name)) return false;
          const dot = n.name.lastIndexOf(".");
          return !taken.has(safeAssetName(dot > 0 ? n.name.slice(0, dot) : n.name));
        });
        return;
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

/*
 * A row's left padding lives in CSS, not here — see FileTree.module.css's
 * `.node`. 设计稿 17 §2g: levels 1–4 step by the density tier's width and from
 * level 5 the step drops to 4px for good (seven levels at 12px would spend
 * 84px on indentation alone, and at that depth indentation only has to say
 * "further right than the line above"). The step *is* the tier, and the tier
 * is a container query, so expressing the rule anywhere but CSS would mean
 * two definitions that disagree while the panel is being dragged.
 */
