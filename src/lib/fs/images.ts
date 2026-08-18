/**
 * Generic project-file utilities for images and text attachments:
 * discovery (scan), classification (by extension), and encoding (base64 data
 * URLs for multimodal prompts / in-app rendering).
 */

import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import { readDir, readFile as readTextFile } from "./fileio";

export type ProjectFileKind = "image" | "text";

export interface ProjectFile {
  name: string;
  path: string;
  kind: ProjectFileKind;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const TEXT_EXTS  = new Set(["md", "txt"]);

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

/** Recursively scan the project folder for image and text files (max depth 5). */
export async function scanProjectFiles(projectPath: string): Promise<ProjectFile[]> {
  const results: ProjectFile[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 5) return;
    try {
      const entries = await readDir(dir);
      for (const e of entries) {
        if (e.isDirectory && !e.name.startsWith(".")) {
          await walk(e.path, depth + 1);
        } else if (!e.isDirectory) {
          const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
          if (IMAGE_EXTS.has(ext)) {
            results.push({ name: e.name, path: e.path, kind: "image" });
          } else if (TEXT_EXTS.has(ext)) {
            results.push({ name: e.name, path: e.path, kind: "text" });
          }
        }
      }
    } catch {
      // unreadable dirs are skipped
    }
  }

  await walk(projectPath, 0);
  return results;
}

/** Read an image file and return a base64 data URL. */
export async function imageToDataUrl(imagePath: string): Promise<{ dataUrl: string; ext: string; bytes: Uint8Array }> {
  // plugin-fs `readFile` already hands back a Uint8Array<ArrayBuffer>. The old
  // `new Uint8Array(bytes as ArrayBuffer)` round-trip was a no-op that copied
  // the whole image: the cast silenced the mismatch (TS 6 rejects it outright,
  // since Uint8Array and ArrayBuffer don't overlap) while the constructor
  // treated the view as array-like and duplicated it element by element.
  const u8 = await readBinaryFile(imagePath);
  const ext = imagePath.split(".").pop()?.toLowerCase() ?? "png";
  const mime = MIME[ext] ?? "image/png";

  // Uint8Array → base64 in chunks to avoid call-stack overflow on large images
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  return { dataUrl: `data:${mime};base64,${base64}`, ext, bytes: u8 };
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
