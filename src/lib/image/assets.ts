/**
 * Illustrations that belong to a manuscript document.
 *
 * Unlike a lore entity — which owns a folder and can keep an `images.md`
 * beside its text — a document is a single `.md` file. Its pictures go in an
 * `assets/` folder next to it and are referenced by a **relative** link, so
 * moving `writing/` somewhere else, or opening the project on another machine,
 * doesn't break every image in the book.
 */

import { fileExists, makeDir, writeBinaryFile } from "../fs/fileio";

/** Folder name for a document's illustrations, beside the document itself. */
const ASSETS_DIR = "assets";

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

/**
 * Strip what a filename may not contain, and cap the length.
 *
 * Document titles become folder names here, and a chapter called
 * "第三章：审判/终局" would otherwise create a nested directory or fail
 * outright depending on the platform.
 */
function safeName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "doc").slice(0, 60);
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
  const group = safeName(stemOf(docPath));
  const dir = `${dirOf(docPath)}/${ASSETS_DIR}/${group}`;
  await makeDir(dir);

  const name = await uniqueAssetName(dir, ext);
  const absPath = `${dir}/${name}`;
  await writeBinaryFile(absPath, bytes);
  return { absPath, relPath: `${ASSETS_DIR}/${group}/${name}` };
}

/** Pick a filename that doesn't collide with anything already in the folder. */
async function uniqueAssetName(dir: string, ext: string): Promise<string> {
  const stem = `img-${Date.now()}`;
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
