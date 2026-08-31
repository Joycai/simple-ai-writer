/**
 * Document import: pick source documents (docx, xlsx, pdf, pptx), plain text
 * (txt, md, html) and pictures, and land each of them in a folder of the
 * workspace where the read-tool agents can reach it (`list_files` /
 * `search_text` only discover the writing tree).
 *
 * Two dispositions, decided by extension:
 *
 * - **Convert** (docx / xlsx / pdf / pptx → markdown). No mainstream model API
 *   accepts a .docx or .xlsx as binary input — they are zip archives, the
 *   bytes are meaningless to the model — so *something* has to convert, and
 *   doing it here means the author can read and edit the result instead of
 *   trusting an opaque server-side extraction.
 * - **Copy as-is** (txt / md / html / images). The same argument runs the
 *   other way: the app already opens these — markdown and text in the editor,
 *   `.html` in the sandboxed preview, pictures in the image view — so
 *   rewriting them would destroy information (a `.txt` renamed to `.md` gets
 *   read as markdown; an image cannot become text at all) to solve a problem
 *   that does not exist. The only thing that changes is the encoding: a GBK
 *   text file is decoded and rewritten as UTF-8, because everything
 *   downstream — editor, agent, export — reads UTF-8 and mojibake looks
 *   exactly like a successful import.
 *
 * There are **two ways in**, and only the first half differs: the picker above
 * ({@link importDocumentsDialog}), and {@link convertProjectFile} for a
 * document that is already in the workspace — dragged in, pulled from git, or
 * imported before this app could convert it. Both end in the same
 * `writeConversion`, so where the markdown and its pictures land does not
 * depend on which door the file came through.
 *
 * The dialog + fs flow follows the lore avatar/gallery pattern: paths picked
 * in the native dialog are auto-scoped for `tauri-plugin-fs` by the dialog
 * plugin (see src-tauri/src/scope.rs module docs), so no new Rust command is
 * needed. Everything below the dialog is split into pure helpers so the
 * naming/dispatch logic is testable without Tauri.
 */

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import { fileExists, makeDir, writeBinaryFile, writeFile } from "../fs/fileio";
import { IMAGE_EXTENSIONS, TEXT_EXTENSIONS } from "../fs/images";
import { assetRelDirFor } from "../image/assets";
import { decodeText } from "./text";
import { tidyMarkdown } from "./markdown";
import { pptxToMarkdown } from "../fs/pptx";
import { xlsxToMarkdown } from "./xlsx";
import { baseName, dirName } from "../paths";

/**
 * What gets converted to markdown. Legacy .doc/.xls/.ppt are left out on
 * purpose: no converter here can read them faithfully, and a half-garbled
 * import looks exactly like a successful one. (The xlsx parser could in fact
 * read .xls, but offering it would drag the same judgement call back in for
 * .doc and .ppt, which have no comparable reader — so the legacy formats stay
 * out together. .ppt in particular is an OLE compound binary, not a zip, so
 * the .pptx reader cannot touch it.)
 */
export const CONVERT_EXTENSIONS = ["docx", "xlsx", "pdf", "pptx"] as const;

/**
 * What gets copied in unchanged, kept in step with the app's own file kinds
 * (`lib/fs/images`) rather than listed again here: whatever the editor, the
 * HTML preview and the `@` picker can already open is exactly what there is no
 * reason to convert.
 */
export const COPY_TEXT_EXTENSIONS = TEXT_EXTENSIONS;
export const COPY_BINARY_EXTENSIONS = IMAGE_EXTENSIONS;

/** Everything the picker offers, convert and copy alike. */
export const IMPORT_EXTENSIONS: readonly string[] = [
  ...CONVERT_EXTENSIONS,
  ...COPY_TEXT_EXTENSIONS,
  ...COPY_BINARY_EXTENSIONS,
];

/** How one file travels into the workspace. */
export type ImportMode = "convert" | "copy-text" | "copy-binary";
export type ConvertExt = (typeof CONVERT_EXTENSIONS)[number];

/**
 * Conversion input cap. Tender documents run tens of MB with embedded scans;
 * beyond this the webview would sit on a frozen conversion for minutes, and
 * the text yield of such a file is almost always a scan (no text layer at all).
 */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** File name (or path) → the lowercased extension, or "" when there is none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * How this importer would handle the file, or null when it would not.
 *
 * The disposition, not just the extension: every caller downstream branches on
 * what happens to the file, and re-deriving that from the extension in three
 * places is how a newly-added format ends up converted in one of them.
 */
export function importMode(name: string): ImportMode | null {
  const ext = extensionOf(name);
  if ((CONVERT_EXTENSIONS as readonly string[]).includes(ext)) return "convert";
  if (COPY_TEXT_EXTENSIONS.includes(ext)) return "copy-text";
  if (COPY_BINARY_EXTENSIONS.includes(ext)) return "copy-binary";
  return null;
}

/**
 * The convertible extension of a file name, or null when this importer would
 * not convert it. The narrowing that {@link importMode} deliberately throws
 * away: `"convert"` is the right answer for the import loop, but both the
 * converter dispatch and the file tree's 转换文档 menu item need to know
 * *which* format — and deriving it a second time with a cast is how one of the
 * two ends up disagreeing with {@link CONVERT_EXTENSIONS}.
 */
export function convertExtOf(name: string): ConvertExt | null {
  const ext = extensionOf(name);
  return (CONVERT_EXTENSIONS as readonly string[]).includes(ext) ? (ext as ConvertExt) : null;
}

/** Basename of a picked path. Re-exported so importers need one import. */
export { baseName };

/** "招标文件.docx" → "招标文件.md" (source extension swapped, not appended). */
export function markdownName(sourceName: string): string {
  const dot = sourceName.lastIndexOf(".");
  const stem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  return `${stem}.md`;
}

/**
 * What the imported file is called in the workspace: a converted document
 * takes the markdown name, a copied one keeps its own — including its
 * extension, which is the whole point of copying it (see the module docs).
 */
export function importedName(sourceName: string, mode: ImportMode): string {
  return mode === "convert" ? markdownName(sourceName) : sourceName;
}

/**
 * First "<stem>.<ext>" / "<stem>-2.<ext>" / … that `exists` denies. Injected
 * predicate rather than direct fs so the numbering rule is testable; the cap
 * matches the sibling-collision loops elsewhere and just guards runaway.
 */
export async function uniqueImportPath(
  dir: string,
  fileName: string,
  exists: (path: string) => Promise<boolean> = fileExists,
): Promise<string> {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const suffix = dot > 0 ? fileName.slice(dot) : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${dir}/${fileName}` : `${dir}/${stem}-${n}${suffix}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`No free name for ${fileName} in ${dir}`);
}

/**
 * A picture a converter pulled out of the source document. The converter
 * embeds the link (`assetRelDir/name`) in its markdown and hands the bytes
 * back here — it stays a pure bytes-in/result-out layer, and the import loop
 * remains the only place that touches the disk.
 */
export interface ConvertedAsset {
  /** File name ("p3-1.jpg"); the directory is the caller's `assetRelDir`. */
  name: string;
  bytes: Uint8Array;
}

/** What a conversion yields: the markdown body plus its extracted images. */
export interface ConvertResult {
  markdown: string;
  assets: ConvertedAsset[];
}

/**
 * Convert one document's bytes to markdown. The docx/pdf converters are
 * lazy-imported modules of their own (both carry a heavy parser); xlsx and
 * pptx parse in Rust so there is nothing to defer.
 *
 * `assetRelDir` is the document-relative folder image links point at
 * ("assets/<group>") — computable before conversion because the import loop
 * fixes the target path first. The pdf, docx and pptx converters extract
 * embedded raster images (pptx does it in Rust, the bytes ride the IPC reply);
 * only xlsx returns an empty asset list — a workbook's pictures are floating
 * decorations with no cell to anchor a link to.
 */
export async function convertToMarkdown(
  ext: ConvertExt,
  data: Uint8Array,
  assetRelDir: string,
): Promise<ConvertResult> {
  switch (ext) {
    case "docx": {
      const { docxToMarkdown } = await import("./docx");
      return docxToMarkdown(data, assetRelDir);
    }
    case "xlsx":
      return { markdown: tidyMarkdown(await xlsxToMarkdown(data)), assets: [] };
    case "pdf": {
      const { pdfToMarkdown } = await import("./pdf");
      return pdfToMarkdown(data, assetRelDir);
    }
    case "pptx":
      return pptxToMarkdown(data, assetRelDir);
  }
}

/**
 * Write one conversion's output: the markdown file, then the pictures it links
 * to. Shared by the import dialog and {@link convertProjectFile} so a document
 * converted from the tree lands byte-for-byte like an imported one — same
 * `assets/<文档名>/` folder, same trailing newline, same failure ordering.
 *
 * Assets after the markdown on purpose: a failure here loses pictures, not the
 * text, and the caller's error channel still reports it while the document
 * itself stays on disk.
 */
async function writeConversion(target: string, ext: ConvertExt, data: Uint8Array): Promise<void> {
  const relDir = assetRelDirFor(target);
  const { markdown, assets } = await convertToMarkdown(ext, data, relDir);
  await writeFile(target, markdown.length ? `${markdown}\n` : "");
  if (assets.length > 0) {
    const dir = `${dirName(target)}/${relDir}`;
    await makeDir(dir);
    for (const asset of assets) {
      await writeBinaryFile(`${dir}/${asset.name}`, asset.bytes);
    }
  }
}

/**
 * Convert a document **already in the workspace** to markdown beside itself,
 * and resolve to the new file's path. The file tree's 转换文档 — a .docx that
 * arrived by drag, by `git pull` or from an earlier version of this app has no
 * other way in, because conversion used to happen only at import time.
 *
 * The original is **kept**. Conversion is lossy in ways the author cannot undo
 * (vector drawings vanish, layout flattens, a spreadsheet's formulas become
 * their last cached values), so the source document stays the record and the
 * markdown is a derived working copy — the same contract as importing, which
 * also never touches what it read. A name collision numbers the new file
 * (`报价表-2.md`) rather than overwriting: the likeliest collision is a second
 * conversion of the same source, i.e. exactly the case where silently
 * replacing an edited markdown would destroy the edits.
 */
export async function convertProjectFile(source: string): Promise<string> {
  const name = baseName(source);
  const ext = convertExtOf(name);
  if (!ext) throw new Error(`Cannot convert to markdown: ${name}`);
  const data = await readBinaryFile(source);
  if (data.byteLength > MAX_IMPORT_BYTES) {
    throw new Error("File is too large to convert (max 64 MB)");
  }
  const target = await uniqueImportPath(dirName(source), markdownName(name));
  await writeConversion(target, ext, data);
  return target;
}

export interface ImportedDocument {
  /** Source path the author picked. */
  source: string;
  /** File written into the project (markdown for a conversion, else a copy). */
  path: string;
}

export interface ImportFailure {
  source: string;
  error: string;
}

export interface ImportOutcome {
  imported: ImportedDocument[];
  failures: ImportFailure[];
}

/**
 * Pick files and import them into `destDir` (a folder in the workspace) —
 * converted or copied as-is per {@link importMode}.
 * Resolves to null when the author cancels the dialog. Failures are collected
 * per file rather than thrown — one unreadable PDF must not abort the other
 * nine imports of a batch.
 */
export async function importDocumentsDialog(
  destDir: string,
  filterName: string,
): Promise<ImportOutcome | null> {
  const picked = await openDialog({
    multiple: true,
    filters: [{ name: filterName, extensions: [...IMPORT_EXTENSIONS] }],
  });
  if (!picked) return null;
  const paths = Array.isArray(picked) ? picked : [picked];
  if (paths.length === 0) return null;

  const outcome: ImportOutcome = { imported: [], failures: [] };
  for (const source of paths) {
    try {
      const name = baseName(source);
      const mode = importMode(name);
      if (!mode) throw new Error(`Unsupported file type: ${name}`);
      const data = await readBinaryFile(source);
      if (data.byteLength > MAX_IMPORT_BYTES) {
        throw new Error("File is too large to import (max 64 MB)");
      }
      const target = await uniqueImportPath(destDir, importedName(name, mode));
      if (mode === "convert") {
        await writeConversion(target, convertExtOf(name)!, data);
      } else if (mode === "copy-text") {
        // Decoded, not copied byte-for-byte: see the module docs on encoding.
        // No `tidyMarkdown` — that is a repair for converter output, and
        // rewriting an author's own file's blank lines is not this importer's
        // business.
        await writeFile(target, decodeText(data));
      } else {
        await writeBinaryFile(target, data);
      }
      outcome.imported.push({ source, path: target });
    } catch (err) {
      outcome.failures.push({
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcome;
}
