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
} {
  const positions = findOccurrences(text, slice);
  const at = positions.indexOf(offset);
  return { occurrences: positions.length, index: at < 0 ? 1 : at + 1 };
}
