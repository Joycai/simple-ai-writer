import { invoke } from "@tauri-apps/api/core";
import { toPosixPath } from "../paths";

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

export async function makeDir(path: string): Promise<void> {
  return invoke("fs_create_dir", { path });
}

export async function fileExists(path: string): Promise<boolean> {
  return invoke("fs_exists", { path });
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
