/**
 * Document import: pick tender/source documents (docx, xlsx, pdf, txt, md),
 * convert each to markdown and write it into a folder in the workspace, where
 * the read-tool agents can reach it (`list_files`/`search_text` only discover
 * the writing tree).
 *
 * Landing as markdown in the tree is the whole design: no mainstream model API
 * accepts a .docx or .xlsx as binary input (they are zip archives — the bytes
 * are meaningless to the model), so *something* has to convert, and doing it
 * here means the author can read and edit the result instead of trusting an
 * opaque server-side extraction.
 *
 * The dialog + fs flow follows the lore avatar/gallery pattern: paths picked
 * in the native dialog are auto-scoped for `tauri-plugin-fs` by the dialog
 * plugin (see src-tauri/src/scope.rs module docs), so no new Rust command is
 * needed. Everything below the dialog is split into pure helpers so the
 * naming/dispatch logic is testable without Tauri.
 */

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import { fileExists, writeFile } from "../fs/fileio";
import { decodeText } from "./text";
import { tidyMarkdown } from "./markdown";
import { xlsxToMarkdown } from "./xlsx";

/**
 * What the picker offers. Legacy .doc/.xls are left out on purpose: no
 * converter here can read them faithfully, and a half-garbled import looks
 * exactly like a successful one. (The xlsx parser could in fact read .xls, but
 * offering it would drag the same judgement call back in for .doc, which has
 * no comparable reader — so both legacy formats stay out together.)
 */
export const IMPORT_EXTENSIONS = ["docx", "xlsx", "pdf", "txt", "md"] as const;
export type ImportableExt = (typeof IMPORT_EXTENSIONS)[number];

/**
 * Conversion input cap. Tender documents run tens of MB with embedded scans;
 * beyond this the webview would sit on a frozen conversion for minutes, and
 * the text yield of such a file is almost always a scan (no text layer at all).
 */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** File name (or path) → the extension this importer handles, or null. */
export function importExtension(name: string): ImportableExt | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return (IMPORT_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as ImportableExt)
    : null;
}

/** Basename of a picked path, tolerant of both separator styles. */
export function baseName(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(sep + 1);
}

/** "招标文件.docx" → "招标文件.md" (source extension swapped, not appended). */
export function markdownName(sourceName: string): string {
  const dot = sourceName.lastIndexOf(".");
  const stem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  return `${stem}.md`;
}

/**
 * First "<stem>.md" / "<stem>-2.md" / … that `exists` denies. Injected
 * predicate rather than direct fs so the numbering rule is testable; the cap
 * matches the sibling-collision loops elsewhere and just guards runaway.
 */
export async function uniqueMarkdownPath(
  dir: string,
  sourceName: string,
  exists: (path: string) => Promise<boolean> = fileExists,
): Promise<string> {
  const name = markdownName(sourceName);
  const stem = name.slice(0, -3);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${dir}/${name}` : `${dir}/${stem}-${n}.md`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`No free name for ${name} in ${dir}`);
}

/**
 * Convert one document's bytes to markdown. The docx/pdf converters are
 * lazy-imported modules of their own (both carry a heavy parser); xlsx parses
 * in Rust so there is nothing to defer; txt/md is a decode + tidy.
 */
export async function convertToMarkdown(
  ext: ImportableExt,
  data: Uint8Array,
): Promise<string> {
  switch (ext) {
    case "docx": {
      const { docxToMarkdown } = await import("./docx");
      return docxToMarkdown(data);
    }
    case "xlsx":
      return tidyMarkdown(await xlsxToMarkdown(data));
    case "pdf": {
      const { pdfToMarkdown } = await import("./pdf");
      return pdfToMarkdown(data);
    }
    case "txt":
    case "md":
      return tidyMarkdown(decodeText(data));
  }
}

export interface ImportedDocument {
  /** Source path the author picked. */
  source: string;
  /** Markdown file written into the project. */
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
 * Pick documents and import them into `destDir` (a folder in the workspace).
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
      const ext = importExtension(source);
      if (!ext) throw new Error(`Unsupported file type: ${baseName(source)}`);
      const data = await readBinaryFile(source);
      if (data.byteLength > MAX_IMPORT_BYTES) {
        throw new Error("File is too large to import (max 64 MB)");
      }
      const markdown = await convertToMarkdown(ext, data);
      const target = await uniqueMarkdownPath(destDir, baseName(source));
      await writeFile(target, markdown.length ? `${markdown}\n` : "");
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
