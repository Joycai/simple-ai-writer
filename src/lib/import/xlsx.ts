/**
 * .xlsx → Markdown. The conversion itself lives in Rust (`src-tauri/src/xlsx.rs`)
 * — this is just the IPC hop.
 *
 * Unlike the docx/pdf converters there is no lazy `import()` to do: the parser
 * ships inside the binary, so an author who never imports a spreadsheet pays
 * nothing for it either way.
 *
 * Bytes are sent as a plain number array, matching `fs_write_binary_file` in
 * lib/fs/fileio.ts — Tauri's IPC is JSON, so this is what a `Vec<u8>` argument
 * expects. It is the reason for the size cap below.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Ceiling on a spreadsheet handed to the converter, well under the 64 MB the
 * importer allows a document in general.
 *
 * The number-array encoding above inflates a file roughly fourfold on its way
 * across IPC, on the UI thread — a 64 MB workbook would freeze the window for
 * seconds before Rust ever sees it. A spreadsheet that large is a data dump
 * rather than a document, and the row cap in xlsx.rs would discard most of it
 * on arrival anyway.
 */
export const MAX_XLSX_BYTES = 16 * 1024 * 1024;

export async function xlsxToMarkdown(data: Uint8Array): Promise<string> {
  if (data.byteLength > MAX_XLSX_BYTES) {
    throw new Error(
      `Spreadsheet is too large to import (max ${MAX_XLSX_BYTES / 1024 / 1024} MB)`,
    );
  }
  return invoke<string>("xlsx_to_markdown", { data: Array.from(data) });
}
