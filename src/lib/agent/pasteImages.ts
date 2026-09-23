/**
 * What a paste into the assistant's composer is, decided before any bytes are
 * read (docs/feature/agent/chat-image-paste-plan.md §3).
 *
 * Pure on purpose: the clipboard itself differs between WKWebView and WebView2
 * and was not measured when this was written (plan §8), so the rules live
 * where a test can pin them and the hook in `components/ai/usePasteImages`
 * only carries bytes.
 */

/** The two fields of a `DataTransferItem` the decision reads. */
interface PasteItem {
  kind: string;
  type: string;
}

/**
 * The formats a paste may bring in, and the extension each is written under.
 *
 * A whitelist mapped from the MIME type, never the clipboard's file name: many
 * sources call every picture `image.png`, some give no name at all. HEIC and
 * TIFF are left out for the reason `image-normalize-plan.md` §3.0 gives.
 */
export const PASTE_IMAGE_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * - `passthrough`: let the textarea paste as it always has.
 * - `images`: take the pictures, swallow the event.
 * - `unsupported`: a file came, but not one of {@link PASTE_IMAGE_EXT} — say so.
 *
 * **Text wins.** Copying a passage out of Word, Excel or a web page often puts
 * a rendered picture of it on the clipboard beside the text; taking the picture
 * would make the passage the author actually wanted impossible to paste.
 */
export function classifyPaste(
  items: readonly PasteItem[],
  hasText: boolean,
): "images" | "unsupported" | "passthrough" {
  if (hasText) return "passthrough";
  const files = items.filter((i) => i.kind === "file");
  if (files.length === 0) return "passthrough";
  return files.some((f) => f.type in PASTE_IMAGE_EXT) ? "images" : "unsupported";
}

/**
 * True for a path inside a chat's scratch area (`.ai-writer/tmp/chat/`), in
 * either separator spelling.
 */
export function isChatStashPath(path: string): boolean {
  return /[\\/]\.ai-writer[\\/]tmp[\\/]chat[\\/]/.test(path);
}

/**
 * The number in 「粘贴的图片 N」: the picture's place among this session's
 * pasted pictures, in the order they were first seen.
 *
 * A content hash names the file, and is a name for neither the author nor the
 * model; "the second pasted picture" is something the author actually says. A
 * picture pasted again keeps its number because it is the same file.
 */
export function pasteDisplayIndex(path: string, known: readonly string[]): number {
  const seen: string[] = [];
  for (const p of known) if (isChatStashPath(p) && !seen.includes(p)) seen.push(p);
  const i = seen.indexOf(path);
  return i >= 0 ? i + 1 : seen.length + 1;
}
