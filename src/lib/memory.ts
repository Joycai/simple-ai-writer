/**
 * Story memory ("前情记忆") — a per-document rolling summary that lets AI tasks
 * see the plot of everything *before* the verbatim reference window.
 *
 * File format (`.ai-writer/memory/<relative doc path>.md`):
 *   - Machine metadata lives in a leading `<!-- ai-writer-memory {json} -->`
 *     comment: source path, covered char count, per-segment ranges + hashes.
 *   - Each segment's summary follows as a human-editable `## …` section, in
 *     the same order as the metadata segments. Authors can freely edit the
 *     summary text; the comment block is regenerated on every update.
 *
 * Staleness model: a segment is stale when the hash of its source slice no
 * longer matches. Edits shift offsets, so an early edit invalidates that
 * segment and everything after it — updates re-summarize from the first stale
 * segment onward while keeping the fresh prefix untouched. Appending to the
 * end (the common writing flow) only ever adds new segments.
 */

import { readFile, writeFile, makeDir, fileExists } from "./fileio";

export interface MemorySegment {
  /** Source char range [from, to) this summary covers. */
  from: number;
  to: number;
  /** FNV-1a hash of the source slice, for staleness detection. */
  hash: string;
  summary: string;
}

export interface DocMemory {
  /** Project-relative path of the source document. */
  sourcePath: string;
  /** Memory covers source chars [0, coveredChars). */
  coveredChars: number;
  updatedAt: string;
  segments: MemorySegment[];
}

export interface MemoryFreshness {
  /** Index of the first stale segment, -1 when all segments are fresh. */
  firstStaleIndex: number;
  /** Chars of source text (from end of fresh coverage to doc end) not covered. */
  uncoveredChars: number;
}

const APPROX_CHARS_PER_TOKEN = 3;
/** Verbatim tail excluded from memory coverage — the detail window handles it. */
export const MEMORY_TAIL_KEEP_CHARS = 2000;
/** Char budget for the 【前情提要】 layer in the assembled context (~1500 tokens). */
export const MEMORY_BUDGET_CHARS = 1500 * APPROX_CHARS_PER_TOKEN;
/** Suggest creating/updating memory when this much pre-window text is uncovered. */
export const MEMORY_SUGGEST_THRESHOLD_CHARS = 10_000;
/** Don't offer memory at all for documents shorter than this. */
export const MEMORY_MIN_DOC_CHARS = 6_000;
const DEFAULT_SEGMENT_CHARS = 12_000;

// ─── Hashing ─────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit — stable, fast, good enough for change detection. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ─── Segmentation ────────────────────────────────────────────────────────────

/**
 * Per-segment source size, derived from the model's context window so one
 * segment + prompt + prior-summary tail always fits. Clamped to keep segments
 * meaningful (≥4k chars) and summaries focused (≤24k chars).
 */
export function segmentTargetChars(contextSize?: number): number {
  if (!contextSize || contextSize <= 0) return DEFAULT_SEGMENT_CHARS;
  const budget = Math.floor(contextSize * APPROX_CHARS_PER_TOKEN * 0.4);
  return Math.max(4_000, Math.min(24_000, budget));
}

/**
 * Split `text[from, to)` into contiguous ranges of roughly `target` chars,
 * preferring paragraph boundaries (blank lines, then single newlines) so
 * segments don't cut mid-sentence.
 */
export function splitRange(
  text: string,
  from: number,
  to: number,
  target: number
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let start = from;
  while (start < to) {
    // A slightly-oversized final chunk beats a tiny orphan segment.
    if (to - start <= Math.floor(target * 1.4)) {
      out.push({ from: start, to });
      break;
    }
    const winEnd = Math.min(to, start + Math.floor(target * 1.3));
    const winStart = start + Math.floor(target * 0.6);
    let cut = start + target;
    const para = text.lastIndexOf("\n\n", winEnd);
    if (para > winStart) {
      cut = para + 2;
    } else {
      const line = text.lastIndexOf("\n", winEnd);
      if (line > winStart) cut = line + 1;
    }
    out.push({ from: start, to: cut });
    start = cut;
  }
  return out;
}

/**
 * Where memory coverage should end for a document: keep the last
 * MEMORY_TAIL_KEEP_CHARS verbatim (the detail window's job), snapped back to a
 * paragraph boundary so the boundary segment reads cleanly.
 */
export function coverEndFor(doc: string): number {
  const candidate = doc.length - MEMORY_TAIL_KEEP_CHARS;
  if (candidate <= 0) return 0;
  const para = doc.lastIndexOf("\n\n", candidate);
  return para > 0 ? para + 2 : candidate;
}

// ─── Serialization ───────────────────────────────────────────────────────────

const META_RE = /^<!--\s*ai-writer-memory\s*\n([\s\S]*?)\n-->/;

export function serializeMemory(mem: DocMemory): string {
  const meta = {
    sourcePath: mem.sourcePath,
    coveredChars: mem.coveredChars,
    updatedAt: mem.updatedAt,
    segments: mem.segments.map(({ from, to, hash }) => ({ from, to, hash })),
  };
  const head = `<!-- ai-writer-memory\n${JSON.stringify(meta)}\n-->\n\n`;
  const body = mem.segments
    .map((s, i) => `## ${i + 1} · ${s.from}–${s.to}\n\n${s.summary.trim()}`)
    .join("\n\n");
  return head + body + "\n";
}

export function parseMemory(raw: string): DocMemory | null {
  const m = raw.match(META_RE);
  if (!m) return null;
  let meta: {
    sourcePath?: unknown;
    coveredChars?: unknown;
    updatedAt?: unknown;
    segments?: unknown;
  };
  try {
    meta = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!meta || !Array.isArray(meta.segments)) return null;

  // Body sections pair with metadata segments by order; heading text is
  // display-only so author edits to headings can't corrupt ranges.
  const body = raw.slice(m[0].length);
  const summaries = body
    .split(/^##[^\n]*$/m)
    .slice(1)
    .map((s) => s.trim());

  const segments: MemorySegment[] = (meta.segments as unknown[]).map((s, i) => {
    const seg = s as { from?: unknown; to?: unknown; hash?: unknown };
    return {
      from: Number(seg.from) || 0,
      to: Number(seg.to) || 0,
      hash: String(seg.hash ?? ""),
      summary: summaries[i] ?? "",
    };
  });

  return {
    sourcePath: String(meta.sourcePath ?? ""),
    coveredChars: Number(meta.coveredChars) || 0,
    updatedAt: String(meta.updatedAt ?? ""),
    segments,
  };
}

// ─── File IO ─────────────────────────────────────────────────────────────────

/** Project-relative path (forward slashes), or null when outside the project. */
export function projectRelativePath(projectPath: string, absPath: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const proj = norm(projectPath);
  const abs = norm(absPath);
  if (!abs.toLowerCase().startsWith(proj.toLowerCase() + "/")) return null;
  return abs.slice(proj.length + 1);
}

export function memoryFilePath(projectPath: string, relPath: string): string {
  return `${projectPath}/.ai-writer/memory/${relPath}`;
}

/** Load the memory file for a document. Null on missing/invalid — never throws. */
export async function loadMemory(
  projectPath: string,
  absDocPath: string
): Promise<DocMemory | null> {
  try {
    const rel = projectRelativePath(projectPath, absDocPath);
    if (!rel) return null;
    const path = memoryFilePath(projectPath, rel);
    if (!(await fileExists(path))) return null;
    return parseMemory(await readFile(path));
  } catch {
    return null;
  }
}

export async function saveMemory(projectPath: string, mem: DocMemory): Promise<void> {
  const path = memoryFilePath(projectPath, mem.sourcePath);
  const dir = path.slice(0, path.lastIndexOf("/"));
  await makeDir(dir);
  await writeFile(path, serializeMemory(mem));
}

// ─── Freshness ───────────────────────────────────────────────────────────────

export function checkFreshness(doc: string, mem: DocMemory): MemoryFreshness {
  let firstStaleIndex = -1;
  for (let i = 0; i < mem.segments.length; i++) {
    const s = mem.segments[i];
    if (s.to > doc.length || hashText(doc.slice(s.from, s.to)) !== s.hash) {
      firstStaleIndex = i;
      break;
    }
  }
  const covered =
    firstStaleIndex === -1
      ? mem.coveredChars
      : firstStaleIndex > 0
        ? mem.segments[firstStaleIndex - 1].to
        : 0;
  return { firstStaleIndex, uncoveredChars: Math.max(0, doc.length - covered) };
}

// ─── Context selection ───────────────────────────────────────────────────────

/**
 * Pick segment summaries for the 【前情提要】 layer: only segments that begin
 * before the verbatim detail window (`detailStart`), newest-first under the
 * char budget (recent plot matters most), returned in story order. When older
 * segments were dropped for budget, an ellipsis marker notes the omission.
 */
export function selectMemoryForContext(
  mem: DocMemory | null | undefined,
  detailStart: number,
  budgetChars: number = MEMORY_BUDGET_CHARS
): string {
  if (!mem || detailStart <= 0) return "";
  const eligible = mem.segments.filter((s) => s.from < detailStart && s.summary.trim());
  if (eligible.length === 0) return "";

  const picked: string[] = [];
  let used = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const text = eligible[i].summary.trim();
    if (picked.length > 0 && used + text.length > budgetChars) break;
    picked.unshift(text);
    used += text.length;
  }
  if (picked.length < eligible.length) {
    picked.unshift("……（更早的前情已因篇幅省略）");
  }
  return picked.join("\n\n");
}
