/**
 * Where an approved find/replace actually lands — the pure half of `applyEdit`.
 *
 * `propose_edit` used to require `find` to be unique in the file, and both ends
 * enforced it: the tool refused to propose an ambiguous edit, and the apply
 * step refused to write one. That rule is right for prose, where a snippet is
 * naturally unique, and wrong for everything structured. A deck's HTML is N
 * near-identical `<section class="slide">` blocks; a table has the same cell
 * text in a dozen rows. There the model could not target the third one at all,
 * and the only fallback was `rewrite_document` — re-emitting the whole file to
 * change one line, which on a long file does not fit in a single reply.
 *
 * So the edit carries a *target*: the single occurrence (as before), the Nth,
 * or all of them. The safety property that made the old uniqueness rule worth
 * having is kept by a different means — the proposal records how many times
 * `find` occurred when the author saw the card, and applying re-counts. If the
 * author kept typing while the card sat there and the count moved, the write
 * is refused rather than landing somewhere they never approved.
 */

import { headingsOf, sectionAt } from "../diff/sections";

/** Which occurrence(s) of `find` an approved edit replaces. */
export type EditTarget = number | "all" | undefined;

/**
 * Offsets of every occurrence, scanning left to right and skipping past each
 * match. Overlapping matches are therefore not counted twice — `"aa"` occurs
 * twice in `"aaaa"`, not three times — which is the count the card showed and
 * the count the model was told.
 */
export function findOccurrences(text: string, find: string): number[] {
  if (!find) return [];
  const out: number[] = [];
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) out.push(i);
  return out;
}

/**
 * Apply an approved edit to the text as it stands *now*.
 *
 * Throws when the document has moved on, with the message the author sees —
 * refusing is always better than writing at a position they did not approve.
 */
export function applyFindReplace(
  text: string,
  find: string,
  replace: string,
  /** How many occurrences existed when the proposal was built. */
  occurrences: number,
  target: EditTarget,
): string {
  const positions = findOccurrences(text, find);
  if (positions.length === 0) {
    throw new Error("Document changed — the target text no longer matches.");
  }
  if (positions.length !== occurrences) {
    // The single-match case keeps its original wording: it is by far the most
    // common, and "too ambiguous" is what the author has been reading.
    throw new Error(
      occurrences === 1
        ? "The target text appears more than once in the document — too ambiguous to apply automatically."
        : `Document changed — the target text now appears ${positions.length} times, not the ${occurrences} shown on the card.`,
    );
  }

  const hits =
    target === "all"
      ? positions
      : [positions[(typeof target === "number" ? target : 1) - 1]];
  if (hits.some((h) => h === undefined)) {
    throw new Error("Document changed — that occurrence no longer exists.");
  }

  // Splice from the end so the earlier offsets stay valid as the text shifts.
  let out = text;
  for (const at of [...hits].reverse()) {
    out = out.slice(0, at) + replace + out.slice(at + find.length);
  }
  return out;
}

/** One line for the log/result text: which of how many this edit touched. */
export function describeEditTarget(occurrences: number, target: EditTarget): string {
  if (occurrences <= 1) return "";
  if (target === "all") return `all ${occurrences} occurrences`;
  return `occurrence ${typeof target === "number" ? target : 1} of ${occurrences}`;
}

// ─── Line ranges (rewrite_lines) ─────────────────────────────────────────────

/**
 * The exact source of lines `from`..`to`, and where it sits.
 *
 * `rewrite_lines` is `propose_edit` with the `find` computed instead of
 * quoted: the model names a line range it has already read, and the tool
 * reads that range off disk itself. That is the whole saving — a chunked
 * rewrite otherwise has to re-emit every original line inside `find` just to
 * say which lines it means, which is the same output cost the whole exercise
 * exists to avoid, plus a fresh way to fail (one mistyped character and the
 * snippet is not found).
 *
 * Sliced by character offset rather than `split("\n").join("\n")` so the
 * original line terminators survive verbatim: a CRLF file must not silently
 * become LF in the rewritten region while the rest of it stays CRLF.
 */
export interface LineSlice {
  /** The lines' source, including the terminator of the last one. */
  text: string;
  /** Character offset where the slice starts. */
  start: number;
  /** Last line actually covered — clamped to the end of the file. */
  to: number;
  /** Total lines in the file, for the "past the end" error. */
  lineCount: number;
}

/** Character offset each 1-based line starts at, plus a sentinel at EOF. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/**
 * Lines in a file, not counting the empty one a trailing newline implies.
 *
 * Shared with `sliceLines` so the "past the end" error names the same last
 * line the slicer would have accepted — a message that disagrees with the
 * check it explains is worse than no message.
 */
export function countLines(text: string): number {
  const starts = lineStarts(text);
  return starts.length > 1 && starts[starts.length - 1] === text.length ? starts.length - 1 : starts.length;
}

/**
 * Longest neighbouring line kept on a proposal.
 *
 * Context is orientation, not content: it answers "where does this land", and a
 * card that quotes four hundred characters of the next paragraph to say so has
 * buried the change it exists to show.
 */
const CONTEXT_LINE_CHARS = 80;

/** One neighbouring line, trimmed and clipped; "" when there is no such line. */
export function clipContextLine(line: string | undefined): string {
  const text = (line ?? "").trim();
  return text.length > CONTEXT_LINE_CHARS ? `${text.slice(0, CONTEXT_LINE_CHARS)}…` : text;
}

/**
 * Lines kept either side of a match.
 *
 * Two, because that is what the card draws at full width (设计稿 02h 1z A); the
 * narrow rail draws one and takes the nearer of them. Kept on the proposal
 * rather than read back at draw time for the same reason the occurrence count
 * is: this is what the author was shown, and the file may move on while the
 * card waits.
 */
const CONTEXT_LINES_KEPT = 2;

/**
 * Longest context line kept for a diff face.
 *
 * Much longer than {@link CONTEXT_LINE_CHARS}, whose job is a one-line quote in
 * a locator: these lines are drawn as part of the change, in the same mono face
 * as the change, and a paragraph of prose cut at eighty characters reads as if
 * the file itself were truncated.
 */
export const DIFF_CONTEXT_CHARS = 240;

/** Where one occurrence of `find` sits in the file, and what surrounds it. */
export interface EditMatch {
  /** 1-based line the match starts on. */
  line: number;
  /** 1-based line the match ends on — the same line unless `find` spans several. */
  endLine: number;
  /** Up to {@link CONTEXT_LINES_KEPT} lines above, in document order (nearest last). */
  before: string[];
  /** Up to {@link CONTEXT_LINES_KEPT} lines below, in document order. */
  after: string[];
  /**
   * Nearest heading at or above the match, without its `#`s.
   *
   * The third thing a locator needs after "which lines" and "which occurrence":
   * a line number says where in the file, and a section title says **where in
   * the book** — which is the one an author actually navigates by.
   */
  section?: string;
}

/**
 * Locate every occurrence, in document order.
 *
 * An edit card can say what a change replaces but not *where* it lands — unless
 * the edit came from `rewrite_lines`, which names a range because the model did.
 * Everything needed to fix that is already in hand when the proposal is built
 * (the file's text and the offsets), so it is recorded there rather than
 * re-derived later against a file that may have moved on in the meantime.
 *
 * `positions` comes from {@link findOccurrences}, so entry *i* is occurrence
 * *i+1* — which is exactly what `EditProposal.target` counts.
 */
export function locateMatches(
  text: string,
  find: string,
  positions: readonly number[],
): EditMatch[] {
  if (positions.length === 0) return [];
  const starts = lineStarts(text);
  const lines = countLines(text);
  const sections = headingsOf(text, lines);

  /** 1-based line containing `offset`, by binary search over the line starts. */
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    // Clamped, because a trailing newline gives `lineStarts` one entry more
    // than the file has lines — the same phantom `countLines` exists to deny.
    return Math.min(lo + 1, lines);
  };

  const lineText = (n: number): string | undefined => {
    if (n < 1 || n > lines) return undefined;
    const from = starts[n - 1];
    const to = n < starts.length ? starts[n] : text.length;
    return text.slice(from, to).replace(/\r?\n$/, "");
  };

  /** `count` lines ending at `last`, or starting at `first`, in document order. */
  const span = (from: number, count: number): string[] => {
    const out: string[] = [];
    for (let n = from; n < from + count; n++) {
      const line = lineText(n);
      if (line !== undefined) out.push(clipDiffLine(line));
    }
    return out;
  };

  return positions.map((pos) => {
    const line = lineAt(pos);
    // The match's last character, not the one past it: a `find` ending in a
    // newline ends on that line, not on the one the newline introduces.
    const endLine = lineAt(pos + Math.max(find.length - 1, 0));
    const above = Math.max(1, line - CONTEXT_LINES_KEPT);
    const section = sectionAt(sections, line);
    return {
      line,
      endLine,
      before: span(above, line - above),
      after: span(endLine + 1, CONTEXT_LINES_KEPT),
      ...(section ? { section } : {}),
    };
  });
}

/** A context line: kept whole (indentation included), only cut if it is enormous. */
function clipDiffLine(line: string): string {
  const text = line.replace(/\r$/, "");
  return text.length > DIFF_CONTEXT_CHARS ? `${text.slice(0, DIFF_CONTEXT_CHARS)}…` : text;
}



/**
 * Slice a line range out of a file. Returns null when `from` is past the end —
 * the one case the caller must refuse rather than clamp, since there is no
 * region to rewrite at all.
 *
 * `to` beyond the last line is clamped instead: "from line 300 to the end" is
 * an ordinary thing to mean, and the model has no way to know the exact last
 * line number until it has read that far.
 */
export function sliceLines(text: string, from: number, to: number): LineSlice | null {
  const starts = lineStarts(text);
  const lineCount = countLines(text);
  if (from < 1 || from > lineCount) return null;

  const last = Math.min(Math.max(to, from), lineCount);
  const start = starts[from - 1];
  // The next line's start, so the range carries its own terminator; at the end
  // of a file with no trailing newline there is none, and EOF is the boundary.
  const end = starts[last] ?? text.length;
  return { text: text.slice(start, end), start, to: last, lineCount };
}

// ─── Insertions (insert_lines) ───────────────────────────────────────────────

/** One insertion: `text` goes in **before** 1-based line `line`. */
export interface Insertion {
  line: number;
  text: string;
}

/**
 * Give an insertion its own terminator, so it cannot weld onto the line it is
 * inserted before.
 *
 * The trailing side is forced and the leading side is not, and that asymmetry
 * is the whole rule: a missing terminator makes `## 标题` and the paragraph
 * below it one line, which is silent corruption; a missing *blank* line above
 * it is a judgement about how the author wants their markdown to breathe, and
 * the model expresses that by starting `text` with a newline.
 *
 * Plain `\n` even in a CRLF file — the same thing `rewrite_lines` does with its
 * welding guard. Two conventions for one file's terminators would be worse than
 * one imperfect one.
 */
function terminate(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** How many lines an insertion adds to the file. */
function insertedLineCount(text: string): number {
  return terminate(text).split("\n").length - 1;
}

/**
 * Splice insertions into the text as it stands *now*.
 *
 * Applied bottom-up, which is what lets the model send the line numbers it read
 * without compensating for its own shifts: every insertion is located in the
 * text before any of them have moved anything. That discipline — "order your
 * edits from the bottom of the file upwards" — is the one `rewrite_lines`
 * asks the model to keep by hand and the one it gets wrong on a long pass, so
 * here it is the mechanism instead of an instruction.
 *
 * `expectedLines` is this write's version of `applyFindReplace`'s `occurrences`,
 * and it is here rather than at the call site for the same reason that one is:
 * the check is the write's precondition, not the caller's courtesy. An edit
 * notices a document that moved on because its `find` no longer counts the
 * same; an insertion has no text to re-find, so the file's *length* is the only
 * evidence available — and every line number on the card is wrong the moment it
 * changes. Splicing anyway would put the heading inside a sentence, and nothing
 * about the result would look wrong to anyone.
 */
export function applyInsertions(
  text: string,
  insertions: readonly Insertion[],
  expectedLines?: number,
): string {
  const lineCount = countLines(text);
  if (expectedLines !== undefined && lineCount !== expectedLines) {
    throw new Error(
      `Document changed — it now has ${lineCount} lines, not the ${expectedLines} the card was built from.`,
    );
  }
  const starts = lineStarts(text);
  const ordered = [...insertions].sort((a, b) => b.line - a.line);

  let out = text;
  for (const ins of ordered) {
    if (!Number.isInteger(ins.line) || ins.line < 1 || ins.line > lineCount) {
      throw new Error(
        `Document changed — line ${ins.line} no longer exists (the file has ${lineCount} line(s)).`,
      );
    }
    const at = starts[ins.line - 1];
    out = out.slice(0, at) + terminate(ins.text) + out.slice(at);
  }
  return out;
}

/**
 * Where each insertion ends up once they have all been applied, in the order
 * the author reads them (ascending).
 *
 * Pure, and the reason it is: this is the number that replaces a re-read, so it
 * is worth being able to test without touching disk. The caller still checks it
 * against the file (see `insertReceipt`) — the arithmetic being right is not
 * the same as the write having done what the arithmetic assumed.
 */
export function insertionLanding(
  insertions: readonly Insertion[],
): { line: number; newLine: number; added: number }[] {
  const ordered = [...insertions].sort((a, b) => a.line - b.line);
  let shift = 0;
  return ordered.map((ins) => {
    const added = insertedLineCount(ins.text);
    const newLine = ins.line + shift;
    shift += added;
    return { line: ins.line, newLine, added };
  });
}

/**
 * Which occurrence of `slice` the one at `offset` is, 1-based, and how many
 * there are in total.
 *
 * A line range is not automatically unique — two chapters can carry the same
 * paragraph, a deck the same slide — so the proposal has to say *which* of
 * them it took, exactly as a targeted `propose_edit` does. Without it the
 * apply step would re-locate to the first match and rewrite the wrong region.
 */
export function occurrenceAt(text: string, slice: string, offset: number): {
  occurrences: number;
  index: number;
  /** Every occurrence's offset — handed back so a caller that wants to locate
      them (see {@link locateMatches}) does not scan the file a second time. */
  positions: number[];
} {
  const positions = findOccurrences(text, slice);
  const at = positions.indexOf(offset);
  return { occurrences: positions.length, index: at < 0 ? 1 : at + 1, positions };
}
