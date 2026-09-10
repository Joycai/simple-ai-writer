import { invoke } from "@tauri-apps/api/core";
import { toPosixPath } from "../paths";

/**
 * Read a text file. Non-UTF-8 encodings (GBK, Shift_JIS, UTF-16 with BOM…) are
 * detected and decoded Rust-side (`decode_text` in commands.rs) instead of
 * erroring, VSCode-style; only genuinely binary content is refused. The string
 * that arrives here is always UTF-8, so a later {@link writeFile} of edited
 * content converts the file to UTF-8 on disk.
 */
export async function readFile(path: string): Promise<string> {
  return invoke("fs_read_text_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("fs_write_text_file", { path, content });
}

export async function appendFile(path: string, content: string): Promise<void> {
  return invoke("fs_append_text_file", { path, content });
}

/**
 * Read raw bytes — for pictures the app copies rather than reads as text.
 *
 * Goes through the fs plugin instead of a command of our own: the plugin
 * returns a `Uint8Array` directly, where our IPC would have to base64 the
 * bytes through JSON the way `writeBinaryFile` does on the way out.
 */
export async function readBinaryFile(path: string): Promise<Uint8Array> {
  const { readFile: pluginReadFile } = await import("@tauri-apps/plugin-fs");
  return pluginReadFile(path);
}

/** A file's real length, plus as much of its head as was asked for. */
export interface FileHead {
  /** The whole file's size in bytes — not `head.byteLength`. */
  size: number;
  head: Uint8Array;
}

/**
 * How big is it, and what do its first `maxBytes` bytes say — one round trip,
 * without paying for the rest of the file.
 *
 * {@link readBinaryFile} is the wrong tool whenever the answer is a number:
 * a 1.5 GB recording crosses the IPC boundary and lands in the webview heap
 * whole. Anything that only needs a size (to quote it, to refuse it) or a
 * container header (RIFF, and one day ID3) comes here instead.
 *
 * `size` is the file's real length even when `head` is a prefix — that is the
 * point, not an accident: a streamed WAV writes a sentinel where its data
 * length belongs, and the only way to recover the duration is to know how far
 * the file actually runs.
 */
export async function readFileHead(path: string, maxBytes: number): Promise<FileHead> {
  const res = await invoke<{ size: number; head: string }>("fs_read_head", {
    path,
    maxBytes: Math.max(0, Math.floor(maxBytes)),
  });
  return { size: res.size, head: fromBase64(res.head) };
}

/**
 * Write raw bytes.
 *
 * Sent as base64, not `Array.from(data)`. The IPC payload is JSON either way,
 * and a 4 MB PNG as a JSON array of numbers is ~15 million characters to
 * serialize here and parse element-by-element on the Rust side; base64 is
 * ~5.5 million and decodes in one pass. A round of conversational image
 * editing writes four candidates, so this runs far more often than it looks.
 */
export async function writeBinaryFile(path: string, data: Uint8Array): Promise<void> {
  return invoke("fs_write_binary_file", { path, data: toBase64(data) });
}

/** Chunked: one `String.fromCharCode(...bytes)` over a whole image overflows the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Inverse of {@link toBase64} — for bytes a Rust command hands back in JSON. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function makeDir(path: string): Promise<void> {
  return invoke("fs_create_dir", { path });
}

export async function fileExists(path: string): Promise<boolean> {
  return invoke("fs_exists", { path });
}

/** One path's kind, size and last modification (ms since the epoch; null where not kept). */
export interface FileStat {
  isDir: boolean;
  size: number;
  modifiedMs: number | null;
}

/** `null` when nothing is at `path`. */
export async function statPath(path: string): Promise<FileStat | null> {
  return invoke("fs_stat", { path });
}

export async function removeDir(path: string): Promise<void> {
  return invoke("fs_remove_dir", { path });
}

export async function removeFile(path: string): Promise<void> {
  return invoke("fs_remove_file", { path });
}

export async function renamePath(from: string, to: string): Promise<void> {
  return invoke("fs_rename", { from, to });
}

/** Copy a file, or a directory with everything under it. `to` must not exist. */
export async function copyPath(from: string, to: string): Promise<void> {
  return invoke("fs_copy", { from, to });
}

/**
 * Open a project file with the OS default application (an .html lands in the
 * system browser). Path containment is enforced Rust-side by `FsScope`, same
 * as every other command here.
 */
export async function openWithDefaultApp(path: string): Promise<void> {
  return invoke("open_with_default_app", { path });
}

/**
 * Open a project .html file in the standalone preview window (its own webview,
 * real viewport, relative links served from disk). Scope-checked in Rust.
 */
export async function previewHtmlWindow(path: string): Promise<void> {
  return invoke("preview_html_window", { path });
}

export interface DirEntry { name: string; path: string; isDirectory: boolean; }

/**
 * One directory's entries, with their paths in the app's POSIX spelling.
 *
 * The Rust side answers in the host's own spelling — `D:\书\第一章.md` on
 * Windows — and this is one of the three doors a path enters the app through
 * (see `lib/paths.ts` and `docs/feature/path-spelling-plan.md`). Normalising here is
 * what makes `LoreEntity.dirPath` — a key that gets written into
 * `agents.json` and the pinned-lore preferences — mean one thing.
 */
export async function readDir(path: string): Promise<DirEntry[]> {
  const raw = await invoke<{ name: string; path: string; is_dir: boolean }[]>("fs_read_dir", { path });
  return raw.map((e) => ({ name: e.name, path: toPosixPath(e.path), isDirectory: e.is_dir }));
}
