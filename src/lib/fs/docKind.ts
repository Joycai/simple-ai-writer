/**
 * What the title bar's document segment offers for one file (设计稿 01e 表 B).
 *
 * One classifier, by extension only — no sniffing, which is also why the answer
 * is available the instant a file is clicked, before anything is read. The
 * five kinds are exactly the five rows of that table, and each one is a
 * different *name list*: what a `.docx` gets is not a greyed-out version of
 * what a chapter gets, it is 转换文档 and nothing else.
 *
 * Kept apart from `isChapterFile` (which decides what enters the outline and
 * the spine) on purpose: widening that one for an outline reason must not
 * silently hand a file an export button.
 */

import { isHtmlPath, isImagePath } from "./images";
import { isExportableDocument } from "./export";
import { convertExtOf } from "../import";

export type DocKind =
  /** md / markdown / txt — editor + markdown preview, the three exports. */
  | "markdown"
  /** html / htm — editor + sandboxed iframe preview; only 打印 · PDF applies. */
  | "html"
  /** A picture the editor renders instead of editing. */
  | "image"
  /** docx / xlsx / pdf / pptx — nothing to edit, but 转换文档 has an outcome. */
  | "convertible"
  /** Anything else the editor cannot read: only the OS can open it. */
  | "opaque";

export function docKindOf(path: string): DocKind {
  if (isImagePath(path)) return "image";
  if (isHtmlPath(path)) return "html";
  if (isExportableDocument(path)) return "markdown";
  if (convertExtOf(path)) return "convertible";
  return "opaque";
}

/**
 * The kinds the editor loads as text — i.e. the ones whose 字数 and 保存态 in
 * the title bar describe *this* file.
 *
 * For every other kind the editor buffer deliberately keeps the previously
 * open document (the AI surfaces read it through `WritingFocus`), so those
 * readouts would be reporting another file's numbers under this file's name.
 */
export function isTextKind(kind: DocKind | null): boolean {
  return kind === "markdown" || kind === "html";
}
