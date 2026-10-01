/**
 * What the title bar's document segment offers for one file (设计稿 01e 表 B).
 *
 * One classifier, by extension only — no sniffing, which is also why the answer
 * is available the instant a file is clicked, before anything is read. The
 * original five kinds follow that table; native slide sources add a sixth. Each is a
 * different *name list*: what a `.docx` gets is not a greyed-out version of
 * what a chapter gets, it is 转换文档 and nothing else.
 *
 * The editor area dispatches on the same answer ({@link isViewOnlyKind},
 * {@link fileNoticeReason}): a bar that offers 转换文档 above a pane that says
 * "reading failed" is two classifiers disagreeing about one file.
 *
 * Kept apart from `isChapterFile` (which decides what enters the outline and
 * the spine) on purpose: widening that one for an outline reason must not
 * silently hand a file an export button.
 */

import { isHtmlPath, isImagePath, isSlidesPath } from "./images";
import { isExportableDocument } from "./export";
import { convertExtOf } from "../import";

export type DocKind =
  /** md / markdown / txt — editor + markdown preview, the three exports. */
  | "markdown"
  /** html / htm — editor + sandboxed iframe preview; only 打印 · PDF applies. */
  | "html"
  /** Native slide source: text editing and resolved slide preview. */
  | "slides"
  /** A picture the editor renders instead of editing. */
  | "image"
  /** docx / xlsx / pdf / pptx — nothing to edit, but 转换文档 has an outcome. */
  | "convertible"
  /** Anything else the editor cannot read: only the OS can open it. */
  | "opaque";

export function docKindOf(path: string): DocKind {
  if (isSlidesPath(path)) return "slides";
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
  return kind === "markdown" || kind === "html" || kind === "slides";
}

/**
 * The kinds the editor never reads as text: a picture is rendered, and a
 * `.docx` gets a page saying what it is and what can be done with it.
 *
 * Known from the extension, so nothing has to fail first. Reading a `.pptx` as
 * text only to have the decoder refuse it is how an ordinary click on a file
 * the app *can* handle (转换文档) used to land on the read-failure page — and
 * a convertible file the decoder happens to accept (an all-ASCII PDF) would
 * open as editable garbage, one keystroke from being autosaved over.
 *
 * `opaque` is not here on purpose: that bucket also holds every text file with
 * an extension this table doesn't list (`.json`, `.csv`, no extension at all),
 * and the only way to tell those from a `.zip` is to read them — see
 * {@link fileNoticeReason}.
 */
export function isViewOnlyKind(kind: DocKind | null): boolean {
  return kind === "image" || kind === "convertible";
}

/**
 * Is this load error `decode_text`'s refusal (`src-tauri/src/commands.rs`) —
 * the bytes carry NUL, so the file is not text in any encoding?
 *
 * That one is an answer, not a fault: retrying gives the same bytes, and the
 * page for it says "this isn't opened here" rather than "reading failed".
 * Every other message (permissions, a vanished file, the scope fence) stays an
 * error. Matched on the message because the command's error *is* a string;
 * `docKind.test.ts` reads the literal out of the Rust source, so rewording it
 * there fails here instead of quietly turning every `.zip` back into an error.
 */
function isNotTextRefusal(message: string): boolean {
  return message.includes("not a text file");
}

/**
 * Why a file has a page in the editor area instead of the editor:
 *
 * - `convertible` — known by extension; never read, so never an error.
 * - `notText` — read, and refused as binary. An answer, not a fault.
 * - `error` — read, and it really failed. The only one that says so.
 */
export type FileNoticeReason = "convertible" | "notText" | "error";

/**
 * Which page the editor area shows for a file that isn't in the buffer, or
 * `null` when it shows the file itself (the editor, or the picture).
 *
 * `loadError` is the message of the failed read *of this file*, if there was
 * one. It can't outrank the extension: a `.docx` is "convertible" whatever a
 * stale or stray read of it said.
 */
export function fileNoticeReason(kind: DocKind, loadError: string | null): FileNoticeReason | null {
  if (kind === "image") return null;
  if (kind === "convertible") return "convertible";
  if (loadError === null) return null;
  return isNotTextRefusal(loadError) ? "notText" : "error";
}
