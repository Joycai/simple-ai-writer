import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export async function readFile(path: string): Promise<string> {
  return readTextFile(path);
}

export async function writeFile(path: string, content: string): Promise<void> {
  return writeTextFile(path, content);
}
