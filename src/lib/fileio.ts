import { invoke } from "@tauri-apps/api/core";

export async function readFile(path: string): Promise<string> {
  return invoke("fs_read_text_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("fs_write_text_file", { path, content });
}

export async function writeBinaryFile(path: string, data: Uint8Array): Promise<void> {
  return invoke("fs_write_binary_file", { path, data: Array.from(data) });
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

export interface DirEntry { name: string; path: string; isDirectory: boolean; }

export async function readDir(path: string): Promise<DirEntry[]> {
  const raw = await invoke<{ name: string; path: string; is_dir: boolean }[]>("fs_read_dir", { path });
  return raw.map((e) => ({ name: e.name, path: e.path, isDirectory: e.is_dir }));
}
