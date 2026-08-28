/**
 * The local side of a sync: entry hashes, and packing/unpacking one entry.
 *
 * All three cross into Rust. Hashing is there because the digest is a wire
 * format shared with the server (`src-tauri/src/lorehash.rs` documents the
 * rules) and because an entry's gallery images should not be read through the
 * webview to be hashed. Zipping is there because `src-tauri/src/transfer.rs`
 * already owns the archive code, including the zip-slip guard that matters most
 * on the *download* path.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { HashMap } from "./model";
import { toPosixPath } from "../paths";

interface RawEntryHash {
  category: string;
  id: string;
  hash: string;
}

/** One tick of local hashing: `done` of `total` entries, `path` = the one being read. */
export interface HashProgress {
  done: number;
  total: number;
  path: string;
}

export function loreRoot(projectPath: string): string {
  return `${toPosixPath(projectPath)}/.ai-writer/lore`;
}

export function entryDir(projectPath: string, path: string): string {
  return `${loreRoot(projectPath)}/${path}`;
}

/**
 * Hash every entry in the project's lore tree, in one IPC hop.
 *
 * `isSyncable` filters what the Rust side deliberately does not: it reports
 * every `<category>/<entity>` directory it finds, leaving the question of which
 * category ids are real to the caller, where the workspace profile lives. Pass
 * a predicate to skip categories this project should not be syncing; without
 * one, everything on disk is included — which is the right default, because a
 * category whose pack is currently disabled still holds the author's entries
 * (the same reason `scanLore` keeps orphan categories).
 *
 * `onProgress` streams one tick per entry from the Rust side. Hashing reads
 * every byte of every gallery image, so on a picture-heavy knowledge base the
 * single IPC call runs for seconds; without the ticks it looks like a hang.
 */
export async function localEntryHashes(
  projectPath: string,
  isSyncable?: (category: string, id: string) => boolean,
  onProgress?: (progress: HashProgress) => void,
): Promise<HashMap> {
  // Always a channel, even with no listener: the Rust side takes it as a
  // required argument (tauri's Channel is a CommandArg, not a Deserialize,
  // so it cannot be optional there).
  const channel = new Channel<HashProgress>();
  if (onProgress) channel.onmessage = onProgress;
  const rows = await invoke<RawEntryHash[]>("lore_tree_hashes", {
    path: loreRoot(projectPath),
    onProgress: channel,
  });
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (isSyncable && !isSyncable(row.category, row.id)) continue;
    out[`${row.category}/${row.id}`] = row.hash;
  }
  return out;
}

/** The content hash of one entry directory — used to verify what a pull wrote. */
export async function hashEntryDir(dir: string): Promise<string> {
  return invoke<string>("lore_entry_hash", { path: dir });
}

/** The archive subtree name. One plain component, as the Rust side requires. */
export const ENTRY_ZIP_PREFIX = "entry";

/** Pack one entry directory into `destZip`. Returns the file count. */
export async function zipEntry(srcDir: string, destZip: string): Promise<number> {
  return invoke<number>("zip_dir_to_path", {
    srcDir,
    destZip,
    prefix: ENTRY_ZIP_PREFIX,
  });
}

/** Unpack an entry archive into `destDir`. Returns the file count. */
export async function unzipEntry(zipPath: string, destDir: string): Promise<number> {
  return invoke<number>("unzip_from_path", {
    zipPath,
    destDir,
    prefix: ENTRY_ZIP_PREFIX,
  });
}

/**
 * This machine's name, for the sync server's "last written by" label.
 *
 * Never throws: the label is decoration, and a platform that will not report a
 * hostname must not stop a sync. "" reaches the server as no header at all.
 */
export async function deviceLabel(): Promise<string> {
  try {
    return await invoke<string>("device_label");
  } catch {
    return "";
  }
}
