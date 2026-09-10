/**
 * A change, cut into the windows a card draws (设计稿 02h · 1a / 1l, rules in 1z A/B).
 *
 * The card's whole vocabulary is one shape: **a window onto the changed place**.
 * Two lines of the file above it and two below so "here" means something,
 * the removed lines above the added ones — always that order, so the eye passes
 * what is being lost before what is being gained — and everything else folded
 * into a sentence that says how much was folded.
 *
 * Two rules keep the card a decision rather than a reader, and both are here
 * rather than in the component because they are judgements about the change,
 * not about the layout:
 *
 * **Token-level highlight is a light that comes on, not a default.** Only when
 * the window changes at most {@link LIT_MAX_CHANGED_LINES} lines and the two
 * sides are still recognisably the same passage. Below that similarity the
 * highlight marks the handful of characters two different sentences happen to
 * share, which is noise wearing the costume of information — the window says
 * 「整段替换」 instead and lets the shapes speak.
 *
 * **The same replacement repeated is one thing that happened, not forty.**
 * A find/replace over 40 occurrences draws two windows and says so; the other
 * 38 are the same two lines with different numbers, and a card that makes the
 * author scroll past them has spent their attention on nothing.
 */

import { INLINE_MIN_SIMILARITY, dice, diffDocument, diffInline, type DiffLine, type DiffSeg } from ".";

/** One drawn line. */
export interface WindowRow {
  type: "context" | "del" | "add" | "gap" | "fold";
  /** The line's text; "" for a gap. */
  text: string;
  /** Line number to print — absent on a gap. */
  line?: number;
  /** Token-level detail, only on a lit window's del/add rows. */
  inline?: DiffSeg[];
  /** Gap and fold only: the lines they stand for. */
  hidden?: number;
  /** Fold only: which side's lines are behind it. */
  side?: "del" | "add";
  /**
   * Past the window's per-side cap: drawn only once the author opens the
   * window (设计稿 02h 1z A).
   *
   * Marked rather than omitted so the model stays the one place that decides
   * *what* a window contains, while the component decides how much of it is on
   * screen — the alternative is two places that both have to be told the cap.
   */
  overflow?: true;
}

/** One window onto one changed place. */
export interface ChangeWindow {
  rows: WindowRow[];
  /**
   * The passage was rewritten rather than edited: no token-level detail, and
   * the locator line says 「整段替换」 so nobody hunts for a highlight that is
   * deliberately absent.
   */
  wholesale: boolean;
}

/** Where a window sits in the file, and the lines around it. */
export interface WindowAnchor {
  /** 1-based line the replaced passage starts on. */
  line: number;
  /** Up to two lines above, in document order (nearest last). */
  before: readonly string[];
  /** Up to two lines below, in document order. */
  after: readonly string[];
}

export interface WindowOptions {
  /** Context lines drawn either side — 2 in the drawer, 1 in the rail. */
  context: number;
  /** Windows drawn before the rest fold — 6 in the drawer, 2 in the rail. */
  maxWindows: number;
}

export interface EditWindows {
  windows: ChangeWindow[];
  /** Occurrences not drawn. */
  hidden: number;
  /** Every occurrence is the same replacement, so the fold sentence can say so. */
  uniform: boolean;
  addedChars: number;
  removedChars: number;
  /** The replacement is the text it replaces — approving would change nothing. */
  empty: boolean;
  /** Everything that changed is whitespace. */
  whitespaceOnly: boolean;
}

/** Most changed lines a window may have and still light its tokens (1z B). */
export const LIT_MAX_CHANGED_LINES = 3;

/**
 * Similarity below which a passage is a rewrite rather than an edit (1z B).
 *
 * The same coefficient and the same number as the core's per-line rule
 * ({@link INLINE_MIN_SIMILARITY}) — re-exported rather than re-chosen, because
 * a window whose lines each light up while the window as a whole calls itself
 * a wholesale replacement would be two rules disagreeing in one card.
 */
export const LIT_MIN_SIMILARITY = INLINE_MIN_SIMILARITY;

/** Occurrences of one identical replacement past which the card stops repeating itself (1z A). */
export const UNIFORM_MIN_OCCURRENCES = 10;

/** Windows drawn for a repeated identical replacement, whatever the width. */
export const UNIFORM_MAX_WINDOWS = 2;

/** Unchanged lines inside one window before the middle collapses into a gap row. */
const INNER_CONTEXT = 2;

/** Big enough that `diffDocument` folds the passage into a single hunk. */
const WHOLE_PASSAGE = 1e9;

/**
 * Cut one edit — a `find`, its `replace`, and every place it lands — into windows.
 *
 * The width-dependent numbers arrive in `options`; the change-dependent ones
 * (whether to light the tokens, whether the repetition is worth drawing twice)
 * are decided here.
 */
export function editWindows(
  find: string,
  replace: string,
  anchors: readonly WindowAnchor[],
  options: WindowOptions,
): EditWindows {
  const diff = diffDocument(find, replace, { context: WHOLE_PASSAGE });
  const lines = diff.hunks[0]?.lines ?? [];
  const changed = lines.filter((l) => l.type !== "equal").length;
  const empty = changed === 0;

  // The same two lines, over and over: draw two and count the rest. The context
  // goes too — the 38th "沈砚 → 沈研" is not made clearer by its neighbours.
  const uniform = anchors.length >= UNIFORM_MIN_OCCURRENCES;
  const context = uniform ? 0 : Math.max(0, options.context);
  const maxWindows = uniform
    ? Math.min(options.maxWindows, UNIFORM_MAX_WINDOWS)
    : Math.max(1, options.maxWindows);

  // A rewritten passage is not a set of edited lines. Both halves of the test
  // matter: a two-line change that shares nothing is still a rewrite, and a
  // faithful edit spread over ten lines is still too much to mark word by word.
  const lit = !empty && changed <= LIT_MAX_CHANGED_LINES && passageSimilarity(lines) >= LIT_MIN_SIMILARITY;
  const wholesale = !empty && !lit && lines.some((l) => l.type === "del") && lines.some((l) => l.type === "add");

  const drawn = empty ? [] : anchors.slice(0, maxWindows);
  const windows = drawn.map((anchor) => ({
    rows: rowsFor(lines, anchor, context, lit),
    wholesale,
  }));

  return {
    windows,
    hidden: empty ? 0 : anchors.length - windows.length,
    uniform,
    ...countChars(lines, lit),
    empty,
    whitespaceOnly: diff.stats.whitespaceOnly,
  };
}

/**
 * What the change added and removed, in characters.
 *
 * Token-level where the tokens are lit — 「金」→「银」 is one character each way,
 * and calling it +17 −16 because the sentence around it was retyped would make
 * the card's headline number useless for exactly the changes it reads best.
 * Whole lines where they are not, which is the honest count for a passage
 * nobody is being asked to compare character by character.
 */
function countChars(
  lines: readonly DiffLine[],
  lit: boolean,
): { addedChars: number; removedChars: number } {
  let addedChars = 0;
  let removedChars = 0;
  for (const line of lines) {
    if (line.type === "del") {
      if (lit && line.inline) {
        for (const seg of line.inline) if (seg.type === "del") removedChars += seg.text.length;
      } else {
        removedChars += line.text.length;
      }
    } else if (line.type === "add") {
      if (lit && line.inline) {
        for (const seg of line.inline) if (seg.type === "add") addedChars += seg.text.length;
      } else {
        addedChars += line.text.length;
      }
    }
  }
  return { addedChars, removedChars };
}

/** The rows of one window: the file's lines around the passage, then the passage's own diff. */
function rowsFor(
  lines: readonly DiffLine[],
  anchor: WindowAnchor,
  context: number,
  lit: boolean,
): WindowRow[] {
  const rows: WindowRow[] = [];

  const above = anchor.before.slice(Math.max(0, anchor.before.length - context));
  above.forEach((text, i) => {
    rows.push({ type: "context", text, line: anchor.line - above.length + i });
  });

  // Old and new lines are numbered from the same place: the passage starts at
  // the same line either way, and the file below it has not moved yet.
  let oldLine = anchor.line;
  let newLine = anchor.line;
  const inner = collapseInner(lines);
  for (const line of inner) {
    if (line.type === "gap") {
      rows.push({ type: "gap", text: "", hidden: line.hidden });
      oldLine += line.hidden;
      newLine += line.hidden;
      continue;
    }
    if (line.type === "equal") {
      rows.push({ type: "context", text: line.text, line: oldLine });
      oldLine++;
      newLine++;
    } else if (line.type === "del") {
      rows.push({ type: "del", text: line.text, line: oldLine, ...(lit && line.inline ? { inline: line.inline } : {}) });
      oldLine++;
    } else {
      rows.push({ type: "add", text: line.text, line: newLine, ...(lit && line.inline ? { inline: line.inline } : {}) });
      newLine++;
    }
  }
  // Removed above, added below — every window, every time. The diff script
  // interleaves them per pair; the card does not.
  sortDelBeforeAdd(rows);

  const below = anchor.after.slice(0, context);
  below.forEach((text, i) => {
    rows.push({ type: "context", text, line: oldLine + i });
  });

  return rows;
}

/** A run of unchanged lines the window does not draw. */
interface Gap {
  type: "gap";
  hidden: number;
}

/**
 * Collapse long unchanged stretches *inside* a passage.
 *
 * A `find` that spans a whole section can carry dozens of untouched lines
 * between two corrections, and drawing them is the "card as reader" failure in
 * miniature. Two lines are kept on each side of the stretch — the ones that
 * touch a change — and the rest becomes one row that says how many.
 */
function collapseInner(lines: readonly DiffLine[]): (DiffLine | Gap)[] {
  const out: (DiffLine | Gap)[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "equal") {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].type === "equal") j++;
    const run = lines.slice(i, j);
    // Nothing precedes the passage's first line and nothing follows its last,
    // so a run at either end only needs context on its inward side.
    const head = i === 0 ? 0 : INNER_CONTEXT;
    const tail = j === lines.length ? 0 : INNER_CONTEXT;
    if (run.length <= head + tail + 1) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, head));
      out.push({ type: "gap", hidden: run.length - head - tail });
      out.push(...run.slice(run.length - tail));
    }
    i = j;
  }
  return out;
}

/** Move every del row of a group above its add rows, keeping each side's order. */
function sortDelBeforeAdd(rows: WindowRow[]): void {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== "del" && rows[i].type !== "add") {
      i++;
      continue;
    }
    let end = i;
    while (end < rows.length && (rows[end].type === "del" || rows[end].type === "add")) end++;
    const group = rows.slice(i, end);
    rows.splice(
      i,
      end - i,
      ...group.filter((r) => r.type === "del"),
      ...group.filter((r) => r.type === "add"),
    );
    i = end;
  }
}

/** Dice similarity of everything the passage removed against everything it added. */
function passageSimilarity(
  lines: readonly { type: string; text: string }[],
): number {
  const before = lines.filter((l) => l.type !== "add").map((l) => l.text).join("\n");
  const after = lines.filter((l) => l.type !== "del").map((l) => l.text).join("\n");
  if (before === after) return 1;
  const segs = diffInline(before, after);
  return segs ? dice(segs) : 0;
}
