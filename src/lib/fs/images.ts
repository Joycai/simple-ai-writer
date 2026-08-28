/**
 * Generic project-file utilities for images and text attachments:
 * classification (by extension — the one definition of what counts as a
 * picture, a readable text file, or an HTML deliverable), picking the
 * candidates out of the project tree, and encoding (base64 data URLs for
 * multimodal prompts / in-app rendering).
 */

import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import { readFile as readTextFile } from "./fileio";
import type { FileNode } from "../project";

export type ProjectFileKind = "image" | "text";

export interface ProjectFile {
  name: string;
  path: string;
  kind: ProjectFileKind;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
/**
 * What counts as a *readable* project file — the `@` picker's text candidates
 * and the import's copy-as-is list both key off this.
 *
 * `.html`/`.htm` belong here even though they are deliverables rather than
 * chapters (docs/feature/html-artifact-plan.md D6): the assistant that wrote the page
 * is the one the author then asks to change it, and `search_text` already
 * scans them (`isSearchableFile`), so leaving them out of `@` only meant the
 * author had to describe a file the model could have been handed. Kept in
 * step with `isChapterFile`'s `markdown` alias so an `.markdown` file is not
 * a chapter everywhere except here.
 */
const TEXT_EXTS  = new Set(["md", "markdown", "txt", "html", "htm"]);

/** The image extensions, for pickers and dialog filters. */
export const IMAGE_EXTENSIONS: readonly string[] = [...IMAGE_EXTS];
/** The text extensions the app opens as-is (no conversion). */
export const TEXT_EXTENSIONS: readonly string[] = [...TEXT_EXTS];

/**
 * Ceiling on one image handed to a model, measured before base64 inflation.
 *
 * Lives here rather than with either caller because both need the same number:
 * the agent's image tools encode a file the *model* asked for, the chat
 * composer encodes one the *author* attached, and a limit that differs between
 * them would let one path build a request the other already knows is too big.
 * The failure it prevents is a timeout, not an error — a 35MB payload spends
 * minutes uploading before anything rejects it.
 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** The extensions {@link isImagePath} accepts, for error messages. */
export const IMAGE_EXT_LIST = [...IMAGE_EXTS].join(", ");

/** True when the path points at an image we can render (by extension). */
export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

const HTML_EXTS = new Set(["html", "htm"]);

/**
 * True when the path points at an HTML document — the third file kind the
 * editor area dispatches on (after images): still edited as text, but
 * previewed in a sandboxed iframe rather than through the markdown renderer.
 */
export function isHtmlPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return HTML_EXTS.has(ext);
}

const MIME: Record<string, string> = {
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif:  "image/gif",
};

/** The mime type an extension implies, defaulting to PNG for the unknown. */
export function imageMimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "image/png";
}

/**
 * Uint8Array → base64, linear in the input.
 *
 * Chunked `fromCharCode` for the call-stack limit, joined once at the end —
 * an accumulating `binary +=` is quadratic in chunk count, which a 12MB image
 * hides and a 150MB PDF turns into minutes of copying (see lib/agent/subagent,
 * which found that out and now shares this).
 */
export function bytesToBase64(u8: Uint8Array): string {
  const chunk = 8192;
  const pieces: string[] = [];
  for (let i = 0; i < u8.length; i += chunk) {
    pieces.push(String.fromCharCode(...u8.subarray(i, i + chunk)));
  }
  return btoa(pieces.join(""));
}

/**
 * The pickable files in an already-read project tree, depth-first.
 *
 * Derived from `projectStore.fileTree` rather than walking the disk again:
 * a second scanner meant the `@` picker kept its own snapshot of the project,
 * taken once when the project opened. A file added afterwards — by the agent,
 * by a copy in Finder — existed in the sidebar and did not exist for `@`, with
 * nothing on screen explaining the difference. One tree, one refresh path.
 *
 * Dotfiles never appear: `read_dir_recursive` skips them on the Rust side, so
 * `.ai-writer/` stays out the same way it does for the agent's read tools.
 */
export function projectFilesFromTree(nodes: FileNode[]): ProjectFile[] {
  const out: ProjectFile[] = [];
  const walk = (list: FileNode[]) => {
    for (const n of list) {
      if (n.is_dir) { walk(n.children ?? []); continue; }
      const f = classifyProjectFile(n.name, n.path);
      if (f) out.push(f);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Classify one file the way the `@` picker classifies the whole tree —
 * `null` means "not attachable" (a .docx, a .db: nothing a model can take raw).
 *
 * Exists for call sites holding a single node rather than the tree — the file
 * tree's 发送到助手 — so their answer to "can this be handed to the assistant"
 * can never drift from the picker's.
 */
export function classifyProjectFile(name: string, path: string): ProjectFile | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return { name, path, kind: "image" };
  if (TEXT_EXTS.has(ext)) return { name, path, kind: "text" };
  return null;
}

/**
 * Read an image file and return a base64 data URL of it, **unchanged**.
 *
 * This is the *rendering* reader: previews, the exported HTML's inlined
 * `<img>`, a lore gallery tile. Whatever is on disk is what comes back.
 *
 * It is deliberately not the reader for a picture on its way to a model —
 * that is `lib/image/normalize.imageForModel`, which may re-encode an
 * oversized one first. The two used to be the same call, and the difference
 * matters in both directions: rendering a downscaled copy loses detail the
 * author is looking at, and `ImageGenModal`'s save path reads bytes here to
 * *write them to disk*, where a re-encode would be permanent damage.
 * When only the bytes are wanted, use {@link readImageBytes}.
 */
export async function imageToDataUrl(imagePath: string): Promise<{ dataUrl: string; ext: string; bytes: Uint8Array }> {
  const { bytes, ext } = await readImageBytes(imagePath);
  return { dataUrl: `data:${imageMimeFor(ext)};base64,${bytesToBase64(bytes)}`, ext, bytes };
}

/**
 * An image file's bytes and extension, with no encoding step.
 *
 * For the paths that write a picture somewhere — an entity's avatar, a
 * document's `assets/` folder — where building a data URL only to discard it
 * was wasted work, and where reaching for the model-bound reader instead
 * would silently re-encode what lands on disk.
 */
export async function readImageBytes(imagePath: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; ext: string }> {
  // plugin-fs `readFile` already hands back a Uint8Array<ArrayBuffer>. The old
  // `new Uint8Array(bytes as ArrayBuffer)` round-trip was a no-op that copied
  // the whole image: the cast silenced the mismatch (TS 6 rejects it outright,
  // since Uint8Array and ArrayBuffer don't overlap) while the constructor
  // treated the view as array-like and duplicated it element by element.
  const bytes = await readBinaryFile(imagePath);
  return { bytes, ext: imagePath.split(".").pop()?.toLowerCase() ?? "png" };
}

/**
 * Read an image file, downscale it, and return a small base64 data URL —
 * for thumbnails only, never for a view where the pixels themselves matter.
 *
 * A generated picture can be several megabytes at full resolution (DashScope's
 * wan models return up to 4096×4096, and even 2048×2048 lands north of 5MB) —
 * inlining that whole thing as a data URL for a ~150px CSS thumbnail wastes
 * memory for no visible benefit, and worse, WebKit has a real ceiling on how
 * large a `data:` URI it will decode into an `<img>`: past it the element
 * renders nothing, with no error to catch. Shrinking the pixels before
 * building the data URL sidesteps both — a `<canvas>` re-encode, not
 * `OffscreenCanvas`, since this app already works around WebView2 quirks and
 * a classic canvas is the more universally-supported path. PNG output keeps
 * transparency (a downscaled generated image is still occasionally an edit
 * result with alpha); size cost at thumbnail resolution is negligible.
 */
export async function imageToThumbnailDataUrl(imagePath: string, maxDim = 320): Promise<string> {
  const u8 = await readBinaryFile(imagePath);
  const blob = new Blob([u8]);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Inverse of `imageToDataUrl`: decode a base64 data URL into the bytes to
 * write, plus the file extension implied by its mime type. Used for images the
 * app received over the wire (AI generation) rather than read from disk.
 */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; ext: string } {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma === -1) throw new Error("Not a data URL");
  const mime = dataUrl.slice(5, comma).replace(";base64", "").trim();
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = Object.entries(MIME).find(([, m]) => m === mime)?.[0] ?? "png";
  return { bytes, ext };
}

/** Read a text file (.md / .txt) and return its content string. */
export async function readTextFileContent(filePath: string): Promise<string> {
  return readTextFile(filePath);
}
