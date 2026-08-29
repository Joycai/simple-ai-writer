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
import { fromBase64, toBase64 } from "./fileio";

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

/**
 * One picture the converter pulled out of the deck — the shape of the
 * importer's `ConvertedAsset`, declared here rather than imported because
 * `lib/import` already depends on this module and a type is not worth the
 * reversed edge.
 */
export interface PptxAsset {
  name: string;
  bytes: Uint8Array;
}

/** What a whole-file conversion yields: markdown plus its extracted pictures. */
export interface PptxImport {
  markdown: string;
  assets: PptxAsset[];
}

/**
 * A whole presentation as markdown — the importer's path.
 *
 * `assetRelDir` is the document-relative folder image links point at
 * ("assets/<文档名>"); it is percent-encoded here, per path segment, so the
 * links Rust embeds match the ones the PDF and docx converters write
 * (`lib/image/assets.ts` convention) without re-implementing the encoding in
 * Rust. Asset bytes ride back base64 and are decoded before they reach the
 * import loop.
 */
export async function pptxToMarkdown(
  data: Uint8Array,
  assetRelDir: string,
): Promise<PptxImport> {
  if (data.byteLength > MAX_PPTX_BYTES) {
    throw new Error(
      `Presentation is too large to import (max ${MAX_PPTX_BYTES / 1024 / 1024} MB)`,
    );
  }
  const assetDir = assetRelDir.split("/").map(encodeURIComponent).join("/");
  const result = await invoke<{
    markdown: string;
    assets: { name: string; data: string }[];
  }>("pptx_to_markdown", { data: toBase64(data), assetDir });
  return {
    markdown: result.markdown,
    assets: result.assets.map((a) => ({ name: a.name, bytes: fromBase64(a.data) })),
  };
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
