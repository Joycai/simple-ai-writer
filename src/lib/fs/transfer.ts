/**
 * Frontend wrappers for the Rust transfer commands (see src-tauri/src/transfer.rs).
 * All of them open a native dialog on the Rust side and resolve to null when
 * the user cancels — callers treat null as a silent no-op, not an error.
 */

import { invoke } from "@tauri-apps/api/core";

/** Zip `srcDir` (stored under `<prefix>/` + optional root manifest.json) to a user-picked path. */
export async function zipExportDialog(
  srcDir: string,
  prefix: string,
  manifest: string | null,
  defaultFileName: string,
): Promise<string | null> {
  return invoke("zip_export_dialog", { srcDir, prefix, manifest, defaultFileName });
}

export interface ZipImportResult {
  zip_path: string;
  manifest: string | null;
  file_count: number;
}

/** Pick a zip and extract its `<prefix>/` subtree into `destDir` (a staging dir inside the project). */
export async function zipImportDialog(
  destDir: string,
  prefix: string,
): Promise<ZipImportResult | null> {
  return invoke("zip_import_dialog", { destDir, prefix });
}

/** Save text content to a user-picked path. */
export async function saveTextFileDialog(
  content: string,
  defaultFileName: string,
  filterName: string,
  extensions: string[],
): Promise<string | null> {
  return invoke("save_text_file_dialog", { content, defaultFileName, filterName, extensions });
}

export interface OpenedTextFile {
  path: string;
  content: string;
}

/** Pick a text file and return its content. */
export async function openTextFileDialog(
  filterName: string,
  extensions: string[],
): Promise<OpenedTextFile | null> {
  return invoke("open_text_file_dialog", { filterName, extensions });
}
