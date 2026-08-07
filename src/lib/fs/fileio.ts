import { invoke } from "@tauri-apps/api/core";

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
function toBase64(bytes: Uint8Array): string {
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

export interface DirEntry { name: string; path: string; isDirectory: boolean; }

export async function readDir(path: string): Promise<DirEntry[]> {
  const raw = await invoke<{ name: string; path: string; is_dir: boolean }[]>("fs_read_dir", { path });
  return raw.map((e) => ({ name: e.name, path: e.path, isDirectory: e.is_dir }));
}
