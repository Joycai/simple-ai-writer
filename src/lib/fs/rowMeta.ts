/**
 * What one file-tree row *is* — the pure half of 设计稿 01b's row anatomy.
 *
 * The panel has a single accent colour, and 设计稿 01b spends it on "the open
 * document" and "the selection". File kinds therefore get no colour of their
 * own: they are told apart by an icon and by the right-hand column, and by two
 * levels of grey — things the author writes (`.md` `.txt` `.html`) against
 * things that merely live in the folder (imported originals, pictures, an
 * `assets/` group). Everything here is derived from names — a node's own, its
 * siblings', and the ones in its subtree; nothing reads a file, and nothing
 * measures.
 */

import { ASSETS_DIR, safeAssetName } from "../image/assets";

/** The seven row kinds 设计稿 01b draws. */
export type RowKind =
  /** A folder the author made. */
  | "folder"
  /** One document's illustration folder — `assets/<文档名>/`. */
  | "assets"
  /** A folder of the author's own that holds pictures and nothing else. */
  | "pictures"
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
 * Which kind this row is, as far as one name and its parent's can say.
 *
 * `parentName` decides `assets` — a folder is an illustration group because of
 * *where* it sits, not what it is called (the author is free to have a folder
 * called 插图 that is an ordinary group).
 *
 * Never returns `pictures`: that one needs the folder's subtree, which is why
 * it is decided by {@link pictureFolders} in one walk and joined back on by
 * {@link resolveRowKind}. Call sites that only classify *files* can keep using
 * this directly.
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
  return kind === "original" || kind === "image" || kind === "assets" || kind === "pictures";
}

/**
 * The right column's text for a file row: the extension in caps, or `null` for
 * a document (`.md` is the default here — its suffix is already hidden from
 * the name, so printing MD would put it back).
 *
 * One column, two meanings: folders show their document count instead. Neither
 * is ever hidden — 设计稿 01b §2e removed the hover buttons precisely so this
 * column never has to yield.
 */
export function extLabel(name: string, kind: RowKind): string | null {
  if (kind === "assets" || kind === "pictures" || kind === "folder") return null;
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

/**
 * Folder names that mean "pictures" when the folder holds no files to judge by.
 *
 * A fallback, never the first word: a folder called `images` full of chapters
 * is a folder of chapters, and mislabelling it is worse than missing it — the
 * author would read the icon as "no manuscript in here". Latin names are
 * matched lower-cased; the Chinese ones are unaffected by case.
 */
const PICTURE_NAMES = new Set([
  "image", "images", "img", "imgs", "pic", "pics", "picture", "pictures",
  "photo", "photos", "screenshot", "screenshots", "gallery", "media",
  "图片", "图", "配图", "插图", "插画", "截图", "图集", "素材",
]);

/** What one subtree holds, as far as `pictures` needs to know. */
interface Tally {
  /** Any file at all, at any depth. */
  hasFile: boolean;
  /** Every file is an image. Vacuously true for a subtree with no files. */
  allImages: boolean;
}

/**
 * Every folder of the author's own that holds pictures and nothing else.
 *
 * **Content first, name second.** A folder qualifies when its subtree has at
 * least one file and *all* of them are images; only when there is no file to
 * judge by does the name get a say ({@link PICTURE_NAMES}). Deciding by name
 * alone would both miss the folders nobody thought to list (`截图`, `素材`,
 * `pics_v2`) and mislabel an `images/` that happens to hold the manuscript.
 *
 * "All, not most" is deliberate: "most" would mean counting, and this module
 * doesn't count. One stray `.pdf` therefore drops the whole folder back to an
 * ordinary one — the cheap failure, chosen over the expensive one.
 *
 * `assets/` and its `assets/<组>` groups are left out: they are their own kind,
 * with a repair action attached that must not be offered for a folder the
 * author made. One bottom-up walk, same shape as {@link orphanedAssetGroups};
 * nothing reads the disk.
 */
export function pictureFolders(nodes: readonly NamedNode[]): Set<string> {
  const marked = new Set<string>();
  const walk = (list: readonly NamedNode[], parentName: string | null): Tally => {
    const tally: Tally = { hasFile: false, allImages: true };
    for (const node of list) {
      if (!node.is_dir) {
        tally.hasFile = true;
        if (rowKind(node.name, false, parentName) !== "image") tally.allImages = false;
        continue;
      }
      const sub = walk(node.children ?? [], node.name);
      if (sub.hasFile) tally.hasFile = true;
      if (!sub.allImages) tally.allImages = false;
      // `rowKind` already excludes `assets/<组>`; the `assets/` folder itself
      // is the one case it calls "folder" that must not be marked.
      if (rowKind(node.name, true, parentName) !== "folder" || node.name === ASSETS_DIR) continue;
      // `allImages` with a file present already implies "at least one image".
      const isPictures = sub.hasFile ? sub.allImages : PICTURE_NAMES.has(node.name.toLowerCase());
      if (isPictures) marked.add(node.path);
    }
    return tally;
  };
  walk(nodes, null);
  return marked;
}

/**
 * The row's kind, name-derived part joined with the subtree-derived one.
 *
 * The single call site for a *row*: keeping the join here rather than in the
 * component is what stops "what counts as a picture folder" from living in two
 * files. `pictureDirs` is one {@link pictureFolders} walk over the whole tree.
 */
export function resolveRowKind(
  node: NamedNode,
  parentName: string | null,
  pictureDirs: ReadonlySet<string>,
): RowKind {
  const kind = rowKind(node.name, node.is_dir, parentName);
  return kind === "folder" && pictureDirs.has(node.path) ? "pictures" : kind;
}

/*
 * A row's left padding lives in CSS, not here — see FileTree.module.css's
 * `.node`. 设计稿 01b §2g: levels 1–4 step by the density tier's width and from
 * level 5 the step drops to 4px for good (seven levels at 12px would spend
 * 84px on indentation alone, and at that depth indentation only has to say
 * "further right than the line above"). The step *is* the tier, and the tier
 * is a container query, so expressing the rule anywhere but CSS would mean
 * two definitions that disagree while the panel is being dragged.
 */
