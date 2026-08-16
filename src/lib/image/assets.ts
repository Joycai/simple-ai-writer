/**
 * Illustrations that belong to a manuscript document.
 *
 * Unlike a lore entity — which owns a folder and can keep an `images.md`
 * beside its text — a document is a single `.md` file. Its pictures go in an
 * `assets/` folder next to it and are referenced by a **relative** link, so
 * moving `writing/` somewhere else, or opening the project on another machine,
 * doesn't break every image in the book.
 */

import {
  fileExists, makeDir, readBinaryFile, readFile, removeDir, renamePath, writeBinaryFile, writeFile,
} from "../fs/fileio";

/**
 * Folder name for a document's illustrations, beside the document itself.
 * Exported so the outline's volume grouping can skip these folders — an
 * `assets/` directory is pictures, not a volume of chapters.
 */
export const ASSETS_DIR = "assets";

/** Directory part of a file path (no trailing slash). */
function dirOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return cut === -1 ? "" : filePath.slice(0, cut);
}

/** Filename without its directory or extension. */
function stemOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const name = cut === -1 ? filePath : filePath.slice(cut + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Longest readable prefix kept when a title is used as a name. */
const MAX_NAME_LEN = 60;

/**
 * Strip what a filename may not contain, and cap the length.
 *
 * Document titles become folder names here, and a chapter called
 * "第三章：审判/终局" would otherwise create a nested directory or fail
 * outright depending on the platform. Shared with the lore gallery, which
 * takes names straight from files the author picked on disk — a macOS file
 * called `a:b?.png` is unwriteable on Windows and would make the whole project
 * uncheckoutable there.
 */
export function safeAssetName(raw: string, fallback = "doc"): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    // Windows refuses to create a name ending in a dot or a space, so
    // "第一章..md" produced a group Windows could not make and `makeDir` threw.
    // Leading dots go too: they would hide the folder, and ".." would escape.
    .replace(/[. ]+$/, "")
    .replace(/^\.+/, "");
  if (!cleaned) return fallback;
  if (cleaned.length <= MAX_NAME_LEN) return cleaned;
  // Truncating alone merges two long titles that share a prefix — routine for
  // 公众号 and 标书 documents — into one folder. A digest of the full name
  // keeps them apart while the readable prefix survives.
  return `${cleaned.slice(0, MAX_NAME_LEN)}-${shortHash(raw)}`;
}

/** FNV-1a, base36 — a stable few characters, not a security property. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, "0").slice(0, 6);
}

/**
 * The folder holding one document's illustrations.
 *
 * Derived from the document's *name*, which is why moving or renaming a
 * document has to bring this along — see `moveDocumentAssets`.
 */
export function assetDirFor(docPath: string): string {
  return `${dirOf(docPath)}/${ASSETS_DIR}/${safeAssetName(stemOf(docPath))}`;
}

export interface SavedAsset {
  /** Absolute path the bytes were written to. */
  absPath: string;
  /** Path relative to the document, for the markdown link. */
  relPath: string;
}

/**
 * Write an illustration next to its document and return both paths.
 *
 * Grouped per document (`assets/<document name>/`) rather than dumped in one
 * flat folder: a book with forty illustrated chapters is otherwise impossible
 * to tidy by hand, and deleting a chapter leaves no clue which files went
 * with it.
 */
export async function saveDocumentAsset(
  docPath: string,
  bytes: Uint8Array,
  ext: string,
): Promise<SavedAsset> {
  // A generated picture has no name of its own, so it gets a timestamp.
  return writeDocumentAsset(docPath, bytes, `img-${Date.now()}`, ext);
}

/**
 * Copy a picture the author already has into the document's asset folder.
 *
 * Same destination and the same relative link as a generated one — so a
 * hand-inserted illustration follows a rename, exports, and is found by
 * `list_files` exactly like the AI's. What differs is the name: the author's
 * own filename is kept, because it is how they will recognise the picture in
 * the folder and in the link. Cleaned through `safeAssetName` first (a macOS
 * name containing `:` or `?` is unwriteable on Windows, and this one came from
 * wherever they happened to have it).
 */
export async function importDocumentAsset(
  docPath: string,
  sourcePath: string,
): Promise<SavedAsset> {
  const bytes = await readBinaryFile(sourcePath);
  const ext = (sourcePath.split(".").pop() ?? "png").toLowerCase();
  return writeDocumentAsset(docPath, bytes, safeAssetName(stemOf(sourcePath), "image"), ext);
}

/** Shared body: make the folder, pick a free name, write. */
async function writeDocumentAsset(
  docPath: string,
  bytes: Uint8Array,
  stem: string,
  ext: string,
): Promise<SavedAsset> {
  const group = safeAssetName(stemOf(docPath));
  const dir = `${dirOf(docPath)}/${ASSETS_DIR}/${group}`;
  await makeDir(dir);

  const name = await uniqueAssetName(dir, stem, ext);
  const absPath = `${dir}/${name}`;
  await writeBinaryFile(absPath, bytes);
  return { absPath, relPath: `${ASSETS_DIR}/${group}/${name}` };
}

/** Pick a filename that doesn't collide with anything already in the folder. */
async function uniqueAssetName(dir: string, stem: string, ext: string): Promise<string> {
  if (!(await fileExists(`${dir}/${stem}.${ext}`))) return `${stem}.${ext}`;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}.${ext}`;
    if (!(await fileExists(`${dir}/${candidate}`))) return candidate;
  }
  return `${stem}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

/**
 * The markdown for an illustration.
 *
 * Its own paragraph, blank lines either side: an image link glued to the
 * surrounding prose renders inline mid-sentence, which is never what an
 * illustration wants. The alt text is the picture's one-line description —
 * it is what a text-only model reading the document will see in place of the
 * image, so an empty one makes the picture invisible.
 */
export function imageMarkdown(relPath: string, alt: string): string {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `\n\n![${alt.replace(/[[\]]/g, "")}](${encoded})\n\n`;
}

// ─── Following the document ──────────────────────────────────────────────────

/** True for a path this module keeps illustrations for. */
export function ownsAssets(path: string): boolean {
  return /\.md$/i.test(path);
}

/**
 * Move a document's illustration folder to follow the document, and rewrite the
 * links inside it.
 *
 * The folder is named after the document and the links are relative, so
 * without this a move breaks every picture in the file (the links resolve
 * under the new folder, where nothing is) and a rename quietly splits the
 * document's illustrations across two directories — the old ones still render,
 * new ones land elsewhere.
 *
 * Call **after** the document itself has moved. Best-effort: pictures are not
 * worth failing a move over, and the alternative to a partial migration is no
 * migration at all.
 */
export async function moveDocumentAssets(from: string, to: string): Promise<void> {
  if (from === to || !ownsAssets(from) || !ownsAssets(to)) return;
  const fromDir = assetDirFor(from);
  const toDir = assetDirFor(to);
  if (fromDir === toDir) return;

  try {
    if (!(await fileExists(fromDir))) return;
    if (await fileExists(toDir)) {
      // Merging two galleries would need per-file collision handling and could
      // overwrite the destination document's own pictures. Leave both alone and
      // say so rather than guessing.
      console.warn(`[assets] ${toDir} already exists; left ${fromDir} in place`);
      return;
    }
    await makeDir(dirOf(toDir));
    await renamePath(fromDir, toDir);
    await rewriteAssetLinks(to, stemOf(from), stemOf(to));
  } catch (e) {
    console.warn(`[assets] could not move illustrations for ${from}:`, e);
  }
}

/**
 * Retire a deleted document's illustration folder.
 *
 * Without this the pictures stay on disk forever, visible in the file tree and
 * attached to nothing. When the delete was backed up, they move next to that
 * backup instead of being removed — a text-only backup restores the document
 * with every image link pointing at a folder that no longer exists.
 */
export async function discardDocumentAssets(
  docPath: string,
  backupPath: string | null,
): Promise<void> {
  if (!ownsAssets(docPath)) return;
  try {
    const dir = assetDirFor(docPath);
    if (!(await fileExists(dir))) return;
    if (backupPath) {
      const dest = `${backupPath}.assets`;
      if (!(await fileExists(dest))) {
        await renamePath(dir, dest);
        return;
      }
    }
    await removeDir(dir);
  } catch (e) {
    console.warn(`[assets] could not clean up illustrations for ${docPath}:`, e);
  }
}

/** Point a moved document's `assets/<old>/…` links at their new folder. */
async function rewriteAssetLinks(docPath: string, fromStem: string, toStem: string): Promise<void> {
  const oldGroup = safeAssetName(fromStem);
  const newGroup = safeAssetName(toStem);
  if (oldGroup === newGroup) return;
  const raw = await readFile(docPath);
  // Both spellings: `imageMarkdown` percent-encodes each segment, but a link
  // typed by hand (or by a model) carries the characters as they are.
  const rewritten = raw
    .split(`${ASSETS_DIR}/${encodeURIComponent(oldGroup)}/`)
    .join(`${ASSETS_DIR}/${encodeURIComponent(newGroup)}/`)
    .split(`${ASSETS_DIR}/${oldGroup}/`)
    .join(`${ASSETS_DIR}/${newGroup}/`);
  if (rewritten !== raw) await writeFile(docPath, rewritten);
}
