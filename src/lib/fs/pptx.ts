/**
 * Reading .pptx — the IPC hops. The conversion itself lives in Rust
 * (`src-tauri/src/pptx.rs`); a .pptx is a zip of XML and the zip reader is
 * already there.
 *
 * In `lib/fs` rather than `lib/import` (where the docx/xlsx/pdf converters
 * live) because a presentation is read from **two** places: the importer
 * converts a whole file on the way into the workspace, and the agent's
 * `read_slides` tool pages through one that is already there. A converter used
 * by the agent has no business living under "import".
 *
 * Legacy `.ppt` is not readable here — see the Rust module docs.
 */

import { invoke } from "@tauri-apps/api/core";
import { toBase64 } from "./fileio";

/**
 * Ceiling on a presentation handed to the whole-file converter.
 *
 * Higher than the xlsx cap because the payload is base64 rather than a JSON
 * array of numbers (~1.33× the file instead of ~4×), and a deck is mostly
 * pictures the converter throws away — a 30 MB file is a normal 40-slide deck
 * with photographs, not a data dump. Still capped: the whole request body is
 * built in webview memory on the UI thread.
 */
export const MAX_PPTX_BYTES = 32 * 1024 * 1024;

/** One range of slides, as `pptx_read_slides` returns it. */
export interface SlideRange {
  markdown: string;
  total_slides: number;
  from_slide: number;
  to_slide: number;
  /** Where a follow-up read should start, or null at the end of the deck. */
  next_slide: number | null;
}

/** Whether this path is a presentation this app can read. */
export function isPptxPath(path: string): boolean {
  return /\.pptx$/i.test(path);
}

/** A whole presentation as markdown — the importer's path. */
export async function pptxToMarkdown(data: Uint8Array): Promise<string> {
  if (data.byteLength > MAX_PPTX_BYTES) {
    throw new Error(
      `Presentation is too large to import (max ${MAX_PPTX_BYTES / 1024 / 1024} MB)`,
    );
  }
  return invoke<string>("pptx_to_markdown", { data: toBase64(data) });
}

/**
 * One range of slides from a presentation **inside the project**.
 *
 * Takes a path, not bytes: the file is already in the workspace, so Rust reads
 * it behind the same `FsScope` check every other file command runs, and paging
 * through a deck never carries the whole thing across IPC.
 */
export async function readPptxSlides(
  path: string,
  startSlide?: number,
  maxChars?: number,
): Promise<SlideRange> {
  return invoke<SlideRange>("pptx_read_slides", { path, startSlide, maxChars });
}
