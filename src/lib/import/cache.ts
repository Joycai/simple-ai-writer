/**
 * The conversion cache's pure layer: where a converted document lives, what
 * its sidecar records, and the three judgements the IO layer defers to —
 * which key a file gets, whether a PDF came out empty, and which entries a
 * sweep should drop. Nothing here touches the disk, so all of it runs in
 * vitest; `cachedConvert.ts` is the one module that does.
 *
 * Why a cache at all, and why it lives under `.ai-writer/tmp/` rather than
 * beside the source document: docs/feature/agent/document-read-plan.md D2.
 * Why the key is the file's content rather than its path + mtime: D3 — the
 * author renaming or moving a file is the *organising* action this tool
 * exists to support, and a rename must not cost a re-conversion, while a
 * same-name overwrite with new content must.
 */

import type { ConvertExt } from "./index";

/** Project-relative root; every entry is one directory under it. */
export const CONVERT_CACHE_DIR = ".ai-writer/tmp/convert";

/**
 * Bump when any converter's output changes shape (a new image-extraction
 * rule, a table format change): every cached entry is then stale at once,
 * and one number is easier to keep honest than one per format.
 */
export const CONVERT_CACHE_VERSION = 1;

/** Entries unused for this long are dropped by the next sweep (D10). */
export const CONVERT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The markdown file inside an entry; pictures sit in `assets/` beside it. */
export const CACHE_DOCUMENT_NAME = "document.md";
export const CACHE_META_NAME = "meta.json";
/** The document-relative folder the converters link pictures from. */
export const CACHE_ASSET_DIR = "assets";

export interface ConvertCacheMeta {
  /** Absolute path the bytes were read from when the entry was made. Display only — the key is the content. */
  source: string;
  ext: ConvertExt;
  bytes: number;
  convertedAt: number;
  lastUsedAt: number;
  version: number;
  /** How many pictures the converter extracted into `assets/`. */
  pictures: number;
}

/** SHA-256 of the bytes as lowercase hex. `crypto.subtle` exists in the webview and in Node. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The entry's directory name: the first 16 hex digits of the content hash.
 * 64 bits is far past what one project's document count can collide on, and
 * the sidecar's `source` makes a collision visible rather than silent.
 */
export function cacheKeyOf(sha256: string): string {
  return sha256.slice(0, 16);
}

export function cacheRootFor(projectPath: string): string {
  return `${projectPath}/${CONVERT_CACHE_DIR}`;
}

export function cacheDirFor(projectPath: string, key: string): string {
  return `${cacheRootFor(projectPath)}/${key}`;
}

/** A sidecar that parses and carries every field; anything else is "no sidecar". */
export function parseCacheMeta(text: string): ConvertCacheMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const source = typeof m.source === "string" ? m.source : null;
  const ext = typeof m.ext === "string" ? (m.ext as ConvertExt) : null;
  const bytes = num(m.bytes);
  const convertedAt = num(m.convertedAt);
  const lastUsedAt = num(m.lastUsedAt);
  const version = num(m.version);
  const pictures = num(m.pictures) ?? 0;
  if (source === null || ext === null || bytes === null || convertedAt === null || lastUsedAt === null || version === null) {
    return null;
  }
  return { source, ext, bytes, convertedAt, lastUsedAt, version, pictures };
}

/** Is this sidecar one the current converters would have written? */
export function isCurrentMeta(meta: ConvertCacheMeta | null): meta is ConvertCacheMeta {
  return meta !== null && meta.version === CONVERT_CACHE_VERSION;
}

/**
 * Characters of real text below which a converted PDF is treated as having no
 * text layer. Page markers, picture links and blank lines do not count — a
 * scan comes out as exactly those and nothing else. 20 is under one line of
 * prose *in Chinese* (a line of CJK is ~30 characters where Latin is ~80), so
 * a document with any text at all clears it while a figure caption or a page
 * number that slipped through does not; tune against real scans (plan §8).
 */
export const SCANNED_TEXT_THRESHOLD = 20;

/**
 * Does the converted markdown carry (almost) no text? For a PDF that means a
 * scan — the local extractor cannot read it, and the tool result says so and
 * points at the two ways out (D5) instead of returning a blank page that
 * reads as "the document is empty".
 */
export function looksScanned(markdown: string): boolean {
  let chars = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^<!--\s*page\s+\d+\s*-->$/.test(t)) continue;
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(t)) continue;
    chars += t.length;
    if (chars >= SCANNED_TEXT_THRESHOLD) return false;
  }
  return true;
}

export interface SweepEntry {
  /** Directory name under the cache root. */
  name: string;
  /** The parsed sidecar, or null when it is missing or unreadable. */
  meta: ConvertCacheMeta | null;
}

/**
 * Which entries a sweep removes: a missing or unparseable sidecar (a
 * conversion that died mid-write, or an in-progress `.tmp-` directory left by
 * a crash), a stale converter version, or a `lastUsedAt` older than the TTL.
 * `keep` spares the entry the current call is about to write or read.
 */
export function planSweep(entries: readonly SweepEntry[], now: number, keep?: string): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === keep) continue;
    if (!isCurrentMeta(e.meta)) {
      out.push(e.name);
      continue;
    }
    if (now - e.meta.lastUsedAt > CONVERT_CACHE_TTL_MS) out.push(e.name);
  }
  return out;
}
