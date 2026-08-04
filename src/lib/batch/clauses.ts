/**
 * Clause splitting for batch runs: turn one tender/source document into the
 * list of items a batch task answers one by one.
 *
 * Two modes, picked automatically:
 *   - "heading"  — markdown headings exist (docx imports keep Word's heading
 *     styles): split at the document's top heading level, so `##` sections
 *     each become one clause with their `###` children inside.
 *   - "numbered" — no usable headings (PDF imports are plain lines): split at
 *     numbered clause lines (2.1 …, 第三条 …), again at the shallowest
 *     numbering depth found.
 *
 * Splitting is deliberately previewable rather than clever: the UI shows the
 * result and lets the author uncheck items, because a mis-split clause fed to
 * the model produces a confidently wrong response, not an error.
 */

export interface Clause {
  /** Heading / numbering line, whitespace-trimmed, for display and output. */
  title: string;
  /** Full clause text including its title line. */
  text: string;
  /**
   * Content before the first boundary (cover page, table of contents). Kept —
   * dropping text silently is worse — but flagged so the UI can default it to
   * unchecked.
   */
  preamble?: boolean;
}

export type SplitMode = "heading" | "numbered" | "none";

export interface SplitResult {
  mode: SplitMode;
  clauses: Clause[];
}

/**
 * Upper bound on clauses. Far above any real tender section count at the top
 * split level; a document that exceeds it is being split at the wrong depth,
 * and a 1000-item batch run is a mistake the author should make on purpose.
 */
export const MAX_CLAUSES = 300;

const HEADING_RE = /^(#{1,6})\s+\S/;
/**
 * 2 / 2.1 / 2.1.3 clause numbers. Three delimiter shapes:
 *   - full-width 、．)） — no space required after ("3、条款" is the common form)
 *   - western "." — space required, so "3.14 meters" isn't read as clause 3
 *   - bare whitespace — "2.1 投标人资质"
 */
const NUMBERED_RE = /^\s*(\d{1,3}(?:\.\d{1,3})*)(?:[、．)）]\s*\S|\.\s+\S|\s+\S)/;
/** 第三条 / 第12章 / 第五节. */
const CN_SECTION_RE = /^\s*第[一二三四五六七八九十百零\d]{1,6}[条章节部分]\s*/;

interface Boundary {
  line: number;
  /** Split depth — heading level, or dot-depth of the clause number. */
  depth: number;
}

function headingBoundaries(lines: string[]): Boundary[] {
  const out: Boundary[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) return;
    const m = HEADING_RE.exec(line);
    if (m) out.push({ line: i, depth: m[1].length });
  });
  return out;
}

function numberedBoundaries(lines: string[]): Boundary[] {
  const out: Boundary[] = [];
  lines.forEach((line, i) => {
    const m = NUMBERED_RE.exec(line);
    if (m) {
      out.push({ line: i, depth: m[1].split(".").length });
      return;
    }
    if (CN_SECTION_RE.test(line)) out.push({ line: i, depth: 1 });
  });
  return out;
}

/** Slice the document at the boundaries whose depth equals the shallowest. */
function sliceAt(lines: string[], boundaries: Boundary[]): Clause[] {
  const top = Math.min(...boundaries.map((b) => b.depth));
  const cuts = boundaries.filter((b) => b.depth === top);
  const clauses: Clause[] = [];

  const preamble = lines.slice(0, cuts[0].line).join("\n").trim();
  if (preamble) {
    clauses.push({ title: firstLine(preamble), text: preamble, preamble: true });
  }
  cuts.forEach((cut, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1].line : lines.length;
    const text = lines.slice(cut.line, end).join("\n").trim();
    if (text) clauses.push({ title: lines[cut.line].trim(), text });
  });
  return clauses;
}

function firstLine(text: string): string {
  return text.slice(0, text.indexOf("\n") < 0 ? undefined : text.indexOf("\n")).trim();
}

/**
 * Split a document into clauses. `mode: "none"` (single clause, whole text)
 * when no structure is detectable — the caller decides whether running one
 * item is still worth it.
 */
export function splitClauses(markdown: string): SplitResult {
  const lines = markdown.split("\n");

  // Headings win when the document really is heading-structured; one stray
  // "# 标题" on a cover page shouldn't force heading mode on a numbered body.
  const headings = headingBoundaries(lines);
  if (headings.length >= 2) {
    const clauses = sliceAt(lines, headings);
    if (clauses.length <= MAX_CLAUSES) return { mode: "heading", clauses };
  }

  const numbered = numberedBoundaries(lines);
  if (numbered.length >= 2) {
    const clauses = sliceAt(lines, numbered);
    if (clauses.length <= MAX_CLAUSES) return { mode: "numbered", clauses };
  }

  const text = markdown.trim();
  return {
    mode: "none",
    clauses: text ? [{ title: firstLine(text), text }] : [],
  };
}
