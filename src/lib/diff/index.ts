/**
 * What changed, in a shape a card can draw.
 *
 * The approval cards can say *how much* changed today (「少了 812 字」) but not
 * *what* — the author approves a replacement without ever seeing the text it
 * replaces. This module is the missing half: two texts in, a hunked diff out,
 * with token-level detail inside the lines that are versions of each other.
 *
 * Three decisions worth knowing before using it:
 *
 * **It refuses rather than degrades silently.** Past the caps below the result
 * carries `degraded` and no hunks, and the caller is expected to fall back to
 * the whole-content view it already has. A diff of two unrelated documents is
 * 3000 red lines above 3000 green ones — technically a diff, and it tells the
 * author strictly less than "整篇替换" would.
 *
 * **Layout numbers are the caller's.** `context` is a parameter and nothing
 * here decides how many lines a card shows, how it folds, or what it says
 * about what it folded. This module answers "what changed"; the card answers
 * "how much of it fits".
 *
 * **Line numbers count like the rest of the app.** A trailing newline does not
 * make a phantom last line (`editApply.countLines`), and `\r` stays on the line
 * it belongs to — so a file that changed only its line endings shows as changed,
 * and `stats.whitespaceOnly` is what says why.
 */

import { diffIndices, intern, type EditStep } from "./myers";
import { tokenize } from "./tokens";

export type { EditStep, EditType } from "./myers";
export { tokenize } from "./tokens";

/** Whether a piece of text is unchanged, added, or removed. */
export type DiffType = "equal" | "add" | "del";

/** One run of same-fate text inside a line. */
export interface DiffSeg {
  type: DiffType;
  text: string;
}

/** One line of a hunk. */
export interface DiffLine {
  type: DiffType;
  /** The line's text, without its newline. */
  text: string;
  /** 1-based line number in the old text; absent on an added line. */
  a?: number;
  /** 1-based line number in the new text; absent on a removed line. */
  b?: number;
  /**
   * Token-level detail, present only on a del/add pair that is recognisably
   * one line rewritten (see {@link INLINE_MIN_SIMILARITY}). Both halves of the
   * pair carry it: the del line's `add` segments and the add line's `del`
   * segments are the parts the renderer skips.
   */
  inline?: DiffSeg[];
}

/** A changed region plus its context lines. */
export interface DiffHunk {
  /** 1-based first line of the hunk on each side. */
  aStart: number;
  bStart: number;
  /** Lines the hunk spans on each side, context included. */
  aCount: number;
  bCount: number;
  lines: DiffLine[];
  /** Unchanged lines between the previous hunk (or the start) and this one. */
  skippedBefore: number;
}

/** Why a diff was not computed. */
export type DiffDegradation =
  /** One of the inputs is past {@link MAX_DIFF_CHARS} / {@link MAX_DIFF_LINES}. */
  | "size"
  /** The two texts differ by more than {@link MAX_LINE_DISTANCE} lines. */
  | "distance";

export interface DiffStats {
  addedLines: number;
  removedLines: number;
  /** Lines present unchanged in both texts. */
  equalLines: number;
  addedChars: number;
  removedChars: number;
  /**
   * Every difference is whitespace: indentation, blank lines, re-wrapping,
   * or a line-ending change. Worth its own flag because it is the one kind of
   * change a diff draws loudly and an author cares about least — and because
   * a "formatting pass" that is *not* whitespace-only is exactly the thing
   * this feature exists to catch.
   */
  whitespaceOnly: boolean;
}

export interface DocumentDiff {
  hunks: DiffHunk[];
  stats: DiffStats;
  /** Set when no hunks could be produced; the caller falls back to whole-content. */
  degraded?: DiffDegradation;
}

export interface DiffOptions {
  /** Unchanged lines kept either side of a change. Default {@link CONTEXT_LINES}. */
  context?: number;
  /** Compute token-level detail inside paired lines. Default true. */
  inline?: boolean;
}

/**
 * Unchanged lines kept either side of a change.
 *
 * Three is the shape a reader recognises from every diff they have seen. It is
 * a default, not a rule: the card passes its own once the mockup settles.
 */
export const CONTEXT_LINES = 3;

/**
 * Largest input this will diff, per side.
 *
 * Well past any chapter, and short of the pasted-in books and saved web pages
 * that also live in a project. Both caps matter separately: 20k lines of prose
 * is a big but ordinary manuscript, while a 400k-character file that is *one
 * line* is a minified page, where the line diff is trivial and the inline diff
 * is the thing that would hang (which is what {@link MAX_INLINE_CHARS} stops).
 */
export const MAX_DIFF_CHARS = 400_000;
export const MAX_DIFF_LINES = 20_000;

/**
 * Most changed lines before the diff is abandoned.
 *
 * Myers costs O(ND) where D is this number, so it is the run-time guard — but
 * it is a legibility guard first. A thousand changed lines is not a review, it
 * is a replacement, and the card should say so in three words instead of
 * drawing two thousand.
 */
export const MAX_LINE_DISTANCE = 1_000;

/** Longest line that gets token-level detail, per side. */
export const MAX_INLINE_CHARS = 4_000;
/** Most changed tokens inside one line before its inline detail is dropped. */
export const MAX_INLINE_DISTANCE = 600;

/**
 * How much of a line must survive for it to count as "this line, rewritten".
 *
 * Below this the two lines are different sentences that happen to be adjacent,
 * and marking the handful of characters they share (a comma, a 的) is worse
 * than not marking anything: it invites the eye to read a relationship that
 * is not there.
 *
 * The number and the formula are the design's (02h 1z B): Dice, `2·shared /
 * (|a| + |b|)`, at 0.5. Measuring against the longer side instead would call
 * a sentence with half of it cut away "the same line, edited" — the cases that
 * most need to read as a replacement are exactly the ones that rule flatters.
 */
export const INLINE_MIN_SIMILARITY = 0.5;

/**
 * Token-level diff of two short texts — the edit card's find/replace, or one
 * line of a document diff.
 *
 * Returns null when either side is past {@link MAX_INLINE_CHARS} or the two
 * differ by more than {@link MAX_INLINE_DISTANCE} tokens; the caller then shows
 * the two texts whole, which is today's behaviour and always safe.
 */
export function diffInline(oldText: string, newText: string): DiffSeg[] | null {
  if (oldText.length > MAX_INLINE_CHARS || newText.length > MAX_INLINE_CHARS) return null;

  const a = tokenize(oldText);
  const b = tokenize(newText);
  const table = new Map<string, number>();
  const aIds = intern(a, table);
  const bIds = intern(b, table);

  const steps = diffIndices(
    a.length,
    b.length,
    (i, j) => aIds[i] === bIds[j],
    MAX_INLINE_DISTANCE,
  );
  if (!steps) return null;

  return mergeSegs(steps.map((s) => ({ type: s.type, text: s.type === "add" ? b[s.b] : a[s.a] })));
}

/**
 * Line diff of two documents, folded into hunks.
 *
 * The result's hunks are in document order and never overlap; runs of
 * unchanged lines between them are reported as `skippedBefore` rather than
 * omitted silently.
 */
export function diffDocument(
  oldText: string,
  newText: string,
  options: DiffOptions = {},
): DocumentDiff {
  const context = options.context ?? CONTEXT_LINES;
  const wantInline = options.inline ?? true;

  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (
    oldText.length > MAX_DIFF_CHARS ||
    newText.length > MAX_DIFF_CHARS ||
    a.length > MAX_DIFF_LINES ||
    b.length > MAX_DIFF_LINES
  ) {
    return { hunks: [], stats: wholesaleStats(a, b, oldText, newText), degraded: "size" };
  }

  const table = new Map<string, number>();
  const aIds = intern(a, table);
  const bIds = intern(b, table);
  const steps = diffIndices(a.length, b.length, (i, j) => aIds[i] === bIds[j], MAX_LINE_DISTANCE);
  if (!steps) {
    return { hunks: [], stats: wholesaleStats(a, b, oldText, newText), degraded: "distance" };
  }

  const lines: DiffLine[] = steps.map((step) => toLine(step, a, b));
  if (wantInline) pairInline(lines);

  return { hunks: buildHunks(lines, context), stats: statsOf(lines) };
}

/** Split into lines the way the rest of the app counts them (see the header note). */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline ends the last line; it does not start an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function toLine(step: EditStep, a: readonly string[], b: readonly string[]): DiffLine {
  switch (step.type) {
    case "equal":
      return { type: "equal", text: a[step.a], a: step.a + 1, b: step.b + 1 };
    case "del":
      return { type: "del", text: a[step.a], a: step.a + 1 };
    case "add":
      return { type: "add", text: b[step.b], b: step.b + 1 };
  }
}

/**
 * Attach token-level detail to del/add pairs.
 *
 * Only *equal-length* runs are paired, index by index. The alternative —
 * matching lines across runs of different lengths — is a second diff problem
 * with its own wrong answers, and the failure it produces is the expensive
 * kind: two unrelated lines drawn as one edited line, which is a claim about
 * the author's text that nothing checked. An unpaired run simply renders as
 * whole removed lines above whole added lines, which is always true.
 */
function pairInline(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "del") {
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < lines.length && lines[delEnd].type === "del") delEnd++;
    let addEnd = delEnd;
    while (addEnd < lines.length && lines[addEnd].type === "add") addEnd++;

    const dels = delEnd - i;
    const adds = addEnd - delEnd;
    if (dels > 0 && dels === adds) {
      for (let k = 0; k < dels; k++) {
        const del = lines[i + k];
        const add = lines[delEnd + k];
        const segs = diffInline(del.text, add.text);
        if (segs && dice(segs) >= INLINE_MIN_SIMILARITY) {
          del.inline = segs;
          add.inline = segs;
        }
      }
    }
    i = addEnd;
  }
}

/**
 * How alike two texts are, 0–1: `2·shared / (|a| + |b|)` (Dice).
 *
 * Exported because the same coefficient decides two things that must agree —
 * whether one line's tokens are worth marking, and whether a whole window is
 * an edit or a rewrite (`diff/windows`).
 */
export function dice(segs: readonly DiffSeg[]): number {
  let shared = 0;
  let aLen = 0;
  let bLen = 0;
  for (const seg of segs) {
    const n = seg.text.length;
    if (seg.type === "equal") {
      shared += n;
      aLen += n;
      bLen += n;
    } else if (seg.type === "del") {
      aLen += n;
    } else {
      bLen += n;
    }
  }
  return aLen + bLen === 0 ? 1 : (2 * shared) / (aLen + bLen);
}

/** Group changed lines with their context, merging regions that would overlap. */
function buildHunks(lines: readonly DiffLine[], context: number): DiffHunk[] {
  const changed: number[] = [];
  lines.forEach((line, i) => {
    if (line.type !== "equal") changed.push(i);
  });
  if (changed.length === 0) return [];

  const ranges: { from: number; to: number }[] = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    // Adjacent as well as overlapping: two hunks with nothing between them
    // would be drawn with a "skipped 0 lines" divider, which is a lie about
    // there being something there.
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  // Where each index sits on both sides, so a hunk that starts with an added
  // line still knows which old line it lands at — `lines[i].a` is absent there,
  // and anchoring on the first line that happens to have a number would put the
  // hunk in the wrong place whenever context is 0.
  const aBefore = new Int32Array(lines.length + 1);
  const bBefore = new Int32Array(lines.length + 1);
  for (let i = 0; i < lines.length; i++) {
    aBefore[i + 1] = aBefore[i] + (lines[i].type === "add" ? 0 : 1);
    bBefore[i + 1] = bBefore[i] + (lines[i].type === "del" ? 0 : 1);
  }

  const hunks: DiffHunk[] = [];
  let consumed = 0;
  for (const range of ranges) {
    const slice = lines.slice(range.from, range.to + 1);
    hunks.push({
      aStart: aBefore[range.from] + 1,
      bStart: bBefore[range.from] + 1,
      aCount: aBefore[range.to + 1] - aBefore[range.from],
      bCount: bBefore[range.to + 1] - bBefore[range.from],
      lines: slice,
      // Every line outside a hunk is unchanged by construction — each changed
      // index is inside some range — so the gap is the skipped count.
      skippedBefore: range.from - consumed,
    });
    consumed = range.to + 1;
  }
  return hunks;
}

function statsOf(lines: readonly DiffLine[]): DiffStats {
  let addedLines = 0;
  let removedLines = 0;
  let equalLines = 0;
  let addedChars = 0;
  let removedChars = 0;
  let removedInk = "";
  let addedInk = "";

  for (const line of lines) {
    if (line.type === "equal") {
      equalLines++;
      continue;
    }
    if (line.type === "add") {
      addedLines++;
      addedChars += line.text.length;
      addedInk += stripSpace(line.text);
    } else {
      removedLines++;
      removedChars += line.text.length;
      removedInk += stripSpace(line.text);
    }
  }

  return {
    addedLines,
    removedLines,
    equalLines,
    addedChars,
    removedChars,
    // Compared across the whole change rather than line by line, so re-wrapping
    // one paragraph into three still reads as whitespace-only.
    whitespaceOnly: addedLines + removedLines > 0 && removedInk === addedInk,
  };
}

/** Stats for a diff that was refused: everything out, everything in. */
function wholesaleStats(
  a: readonly string[],
  b: readonly string[],
  oldText: string,
  newText: string,
): DiffStats {
  return {
    addedLines: b.length,
    removedLines: a.length,
    equalLines: 0,
    addedChars: newText.length,
    removedChars: oldText.length,
    whitespaceOnly: false,
  };
}

function stripSpace(text: string): string {
  return text.replace(/\s+/gu, "");
}

/** Collapse neighbouring segments of the same fate so the renderer gets runs, not tokens. */
function mergeSegs(segs: readonly DiffSeg[]): DiffSeg[] {
  const out: DiffSeg[] = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.type === seg.type) last.text += seg.text;
    else out.push({ type: seg.type, text: seg.text });
  }
  return out;
}

/** Total inline segments' text on one side — handy for callers sizing a preview. */
export function segText(segs: readonly DiffSeg[], side: "a" | "b"): string {
  const skip: DiffType = side === "a" ? "add" : "del";
  return segs
    .filter((s) => s.type !== skip)
    .map((s) => s.text)
    .join("");
}
