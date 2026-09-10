/**
 * A whole-file rewrite, cut into windows (设计稿 02h 1b, rules 1z A/B).
 *
 * The card this feeds answers one question: 「少了 812 字」 — **which** 812?
 * Everything here exists to give those characters a name and a place.
 *
 * Three decisions, all of them the design's and all of them load-bearing:
 *
 * **Blocks, not lines.** A rewrite is compared paragraph by paragraph, split on
 * blank lines. Line-level is the wrong grain twice over: a reflowed paragraph
 * becomes a dozen unrelated line changes, and 「合并」 — two paragraphs folded
 * into one, the commonest thing a tidying pass does — is not expressible at all
 * as lines, so it arrives as noise instead of as one legible fact.
 *
 * **Removals first, punctuation last.** The window order is 删 → 替换/合并 →
 * 加 → 标点/空白, because that is the order of what an author stands to lose.
 * Punctuation groups are counted and folded rather than drawn: thirty-seven of
 * them cannot change the word count and would push everything that can off the
 * screen.
 *
 * **Nothing is silently dropped.** Every group the card does not draw is
 * counted by kind, so the fold sentence can say what it is hiding.
 */

import {
  MAX_DIFF_CHARS,
  MAX_DIFF_LINES,
  MAX_LINE_DISTANCE,
  dice,
  diffInline,
  splitLines,
  type DiffDegradation,
} from ".";
import { diffIndices, intern } from "./myers";
import { headingsOf, sectionAt } from "./sections";
import type { WindowOptions, WindowRow } from "./windows";

/** What happened to one group of blocks. */
export type BlockChangeKind = "del" | "replace" | "merge" | "add" | "punct";

/** One window onto one changed group of paragraphs. */
export interface BlockWindow {
  kind: BlockChangeKind;
  /** Nearest heading above the change. */
  section?: string;
  /** Old-side line range. Absent for a pure addition, which removes no lines. */
  from?: number;
  to?: number;
  /** New-side line range. Absent for a pure deletion. */
  newFrom?: number;
  newTo?: number;
  removedChars: number;
  addedChars: number;
  /** Whole paragraphs went, rather than parts of them — the card says 整段. */
  wholeBlocks: boolean;
  rows: WindowRow[];
  /** Rows marked `overflow` on each side: what the in-window fold hides. */
  hiddenDel: number;
  hiddenAdd: number;
}

export interface RewriteSummary {
  /** Paragraphs removed outright, and what they weighed. */
  deletedBlocks: number;
  deletedChars: number;
  mergeCount: number;
  replaceCount: number;
  addedBlocks: number;
  punctCount: number;
}

export interface RewriteWindows {
  windows: BlockWindow[];
  /** Groups the card is not drawing, by kind — the fold sentence's material. */
  hidden: Record<BlockChangeKind, number>;
  hiddenTotal: number;
  summary: RewriteSummary;
  addedChars: number;
  removedChars: number;
  /** Nothing changed at all. */
  empty: boolean;
  degraded?: DiffDegradation;
}

/**
 * How alike a merged paragraph must be to each of its sources (1z B).
 *
 * Deliberately lower than the token-highlight threshold: a merge keeps most of
 * two paragraphs but rewrites the seam, so each source survives in it only
 * partly. Below this the group is an ordinary replacement, which claims less.
 */
export const MERGE_MIN_SIMILARITY = 0.3;

/** Lines drawn per side inside one window before the rest fold (1z A). */
export const WINDOW_ROWS_PER_SIDE = 2;

/** Unchanged lines between two groups that still make them one window (1z A). */
export const ADJACENT_MERGE_LINES = 4;

/** Draw order. Replacements and merges share a tier and keep document order. */
const TIER: Record<BlockChangeKind, number> = {
  del: 0,
  replace: 1,
  merge: 1,
  add: 2,
  punct: 3,
};

/** One paragraph, and where it sits. */
export interface Block {
  /** 1-based first and last line. */
  from: number;
  to: number;
  text: string;
}

/**
 * Split into paragraphs on blank lines.
 *
 * Blank lines belong to no block: they are the separator, and counting them
 * into a paragraph would make "a blank line was added" look like the paragraph
 * changed.
 */
export function splitBlocks(text: string): Block[] {
  const lines = splitLines(text);
  const out: Block[] = [];
  let start = -1;
  lines.forEach((line, i) => {
    const blank = line.trim() === "";
    if (blank) {
      if (start >= 0) {
        out.push({ from: start + 1, to: i, text: lines.slice(start, i).join("\n") });
        start = -1;
      }
      return;
    }
    if (start < 0) start = i;
  });
  if (start >= 0) {
    out.push({ from: start + 1, to: lines.length, text: lines.slice(start).join("\n") });
  }
  return out;
}

/** One run of removed blocks and the run of added blocks that follows it. */
interface Group {
  dels: Block[];
  adds: Block[];
}

/**
 * Cut a rewrite into windows.
 *
 * `options` carries the width-dependent numbers (context lines, how many
 * windows fit); everything else is decided from the change itself.
 */
export function rewriteWindows(
  original: string,
  content: string,
  options: WindowOptions,
): RewriteWindows {
  const oldLines = splitLines(original);
  const newLines = splitLines(content);
  const empty = original === content;

  if (
    original.length > MAX_DIFF_CHARS ||
    content.length > MAX_DIFF_CHARS ||
    oldLines.length > MAX_DIFF_LINES ||
    newLines.length > MAX_DIFF_LINES
  ) {
    return degraded("size", original, content);
  }

  const oldBlocks = splitBlocks(original);
  const newBlocks = splitBlocks(content);
  const table = new Map<string, number>();
  const oldIds = intern(oldBlocks.map((b) => b.text), table);
  const newIds = intern(newBlocks.map((b) => b.text), table);
  const steps = diffIndices(
    oldBlocks.length,
    newBlocks.length,
    (i, j) => oldIds[i] === newIds[j],
    MAX_LINE_DISTANCE,
  );
  if (!steps) return degraded("distance", original, content);

  const groups: Group[] = [];
  let current: Group | null = null;
  for (const step of steps) {
    if (step.type === "equal") {
      current = null;
      continue;
    }
    // One run of changed blocks is one thing that happened, whichever order the
    // edit script emits its halves in — Myers is free to put the additions of a
    // replacement before its removals, and a grouping that believed the order
    // would read a two-into-one merge as an unrelated delete and add.
    if (!current) {
      current = { dels: [], adds: [] };
      groups.push(current);
    }
    if (step.type === "del") current.dels.push(oldBlocks[step.a]);
    else current.adds.push(newBlocks[step.b]);
  }

  // Classified before neighbours are joined, never after. Joining first makes
  // the model invent facts: a deletion three lines above an unrelated rewrite
  // becomes two removals and one addition, which is the exact shape of a merge,
  // and the card would then tell the author two paragraphs had been welded
  // together when nothing of the sort happened. It also loses the punctuation
  // count, which is the one number the summary cannot recompute.
  const classified = mergeAdjacent(groups.map((group) => ({ group, kind: classify(group) })));

  const summary: RewriteSummary = {
    deletedBlocks: 0,
    deletedChars: 0,
    mergeCount: 0,
    replaceCount: 0,
    addedBlocks: 0,
    punctCount: 0,
  };
  let addedChars = 0;
  let removedChars = 0;
  for (const { group, kind } of classified) {
    const removed = group.dels.reduce((n, b) => n + b.text.length, 0);
    const added = group.adds.reduce((n, b) => n + b.text.length, 0);
    removedChars += removed;
    addedChars += added;
    if (kind === "del") {
      summary.deletedBlocks += group.dels.length;
      summary.deletedChars += removed;
    } else if (kind === "merge") {
      summary.mergeCount++;
    } else if (kind === "replace") {
      summary.replaceCount++;
    } else if (kind === "add") {
      summary.addedBlocks += group.adds.length;
    } else {
      summary.punctCount++;
    }
  }

  // Punctuation is counted, not drawn — unless it is all there is, in which
  // case a card with no windows would be hiding the only thing that happened.
  const punctFolded = classified.some(({ kind }) => kind !== "punct");
  const drawable = punctFolded ? classified.filter(({ kind }) => kind !== "punct") : classified;

  const ordered = drawable
    .map((entry, i) => ({ ...entry, at: i }))
    .sort((a, b) => TIER[a.kind] - TIER[b.kind] || a.at - b.at);
  const drawn = ordered.slice(0, Math.max(1, options.maxWindows));

  const hidden: Record<BlockChangeKind, number> = {
    del: 0,
    replace: 0,
    merge: 0,
    add: 0,
    punct: punctFolded ? summary.punctCount : 0,
  };
  for (const { kind } of ordered.slice(drawn.length)) hidden[kind]++;

  const headings = headingsOf(original);
  const windows = drawn.map(({ group, kind }) =>
    buildWindow(group, kind, oldLines, newLines, headings, options.context),
  );

  return {
    windows,
    hidden,
    hiddenTotal: Object.values(hidden).reduce((a, b) => a + b, 0),
    summary,
    addedChars,
    removedChars,
    empty,
  };
}

/** One classified group. */
interface Classified {
  group: Group;
  kind: BlockChangeKind;
}

/**
 * Two changes of the *same* kind with only a line or two between them read as
 * one window (1z A).
 *
 * Same kind is the whole condition. Two removals a line apart are one removal
 * as far as a reader is concerned; a removal a line above a punctuation fix is
 * two different facts that happen to be neighbours, and drawing them as one
 * would put a fact in the window that its header does not describe.
 */
function mergeAdjacent(groups: readonly Classified[]): Classified[] {
  const out: Classified[] = [];
  for (const entry of groups) {
    const last = out[out.length - 1];
    const lastLine = lastOldLine(last?.group);
    const firstLine = firstOldLine(entry.group);
    if (
      last &&
      last.kind === entry.kind &&
      lastLine !== undefined &&
      firstLine !== undefined &&
      firstLine - lastLine - 1 <= ADJACENT_MERGE_LINES
    ) {
      last.group.dels.push(...entry.group.dels);
      last.group.adds.push(...entry.group.adds);
      continue;
    }
    out.push({ kind: entry.kind, group: { dels: [...entry.group.dels], adds: [...entry.group.adds] } });
  }
  return out;
}

function firstOldLine(group: Group): number | undefined {
  return group.dels[0]?.from;
}

function lastOldLine(group: Group | undefined): number | undefined {
  return group?.dels[group.dels.length - 1]?.to;
}

/** What kind of change a group is. */
function classify(group: Group): BlockChangeKind {
  const { dels, adds } = group;
  if (dels.length === 0) return "add";
  if (adds.length === 0) return "del";

  // Punctuation and whitespace only: the same words, differently pointed. It
  // cannot change the word count, which is why it is counted and folded.
  const before = strip(dels.map((b) => b.text).join(""));
  const after = strip(adds.map((b) => b.text).join(""));
  if (before === after) return "punct";

  // Two paragraphs welded into one: each source has to survive in the result,
  // or this is an ordinary replacement wearing a merge's shape.
  if (dels.length >= 2 && adds.length === 1) {
    const target = adds[0].text;
    const alike = dels.every((del) => {
      const segs = diffInline(del.text, target);
      return segs !== null && dice(segs) >= MERGE_MIN_SIMILARITY;
    });
    if (alike) return "merge";
  }
  return "replace";
}

/** Everything that is not a word: whitespace, punctuation, symbols. */
function strip(text: string): string {
  return text.replace(/[\p{P}\p{S}\s]/gu, "");
}

/** The rows of one window, with the overflow past the per-side cap marked. */
function buildWindow(
  group: Group,
  kind: BlockChangeKind,
  oldLines: readonly string[],
  newLines: readonly string[],
  headings: readonly { line: number; title: string }[],
  context: number,
): BlockWindow {
  const from = group.dels[0]?.from;
  const to = group.dels[group.dels.length - 1]?.to;
  const newFrom = group.adds[0]?.from;
  const newTo = group.adds[group.adds.length - 1]?.to;

  const rows: WindowRow[] = [];
  const anchorLine = from ?? newFrom ?? 1;
  for (let i = Math.max(1, anchorLine - context); i < anchorLine; i++) {
    rows.push({ type: "context", text: oldLines[i - 1] ?? "", line: i });
  }

  let delSeen = 0;
  for (const block of group.dels) {
    for (let line = block.from; line <= block.to; line++) {
      delSeen++;
      rows.push({
        type: "del",
        text: oldLines[line - 1] ?? "",
        line,
        ...(delSeen > WINDOW_ROWS_PER_SIDE ? { overflow: true as const } : {}),
      });
    }
  }
  // The fold sits where the lines it stands for were, between the last drawn
  // removal and the first addition — its position is part of what it means.
  if (delSeen > WINDOW_ROWS_PER_SIDE) {
    rows.push({ type: "fold", text: "", side: "del", hidden: delSeen - WINDOW_ROWS_PER_SIDE });
  }
  let addSeen = 0;
  for (const block of group.adds) {
    for (let line = block.from; line <= block.to; line++) {
      addSeen++;
      rows.push({
        type: "add",
        text: newLines[line - 1] ?? "",
        line,
        ...(addSeen > WINDOW_ROWS_PER_SIDE ? { overflow: true as const } : {}),
      });
    }
  }
  if (addSeen > WINDOW_ROWS_PER_SIDE) {
    rows.push({ type: "fold", text: "", side: "add", hidden: addSeen - WINDOW_ROWS_PER_SIDE });
  }

  const after = (to ?? anchorLine) + 1;
  for (let i = after; i < after + context && i <= oldLines.length; i++) {
    rows.push({ type: "context", text: oldLines[i - 1] ?? "", line: i });
  }

  return {
    kind,
    ...(sectionAt(headings, anchorLine) ? { section: sectionAt(headings, anchorLine) } : {}),
    ...(from !== undefined ? { from, to } : {}),
    ...(newFrom !== undefined ? { newFrom, newTo } : {}),
    removedChars: group.dels.reduce((n, b) => n + b.text.length, 0),
    addedChars: group.adds.reduce((n, b) => n + b.text.length, 0),
    // Whole paragraphs left the document; nothing took their place.
    wholeBlocks: kind === "del",
    rows,
    hiddenDel: Math.max(0, delSeen - WINDOW_ROWS_PER_SIDE),
    hiddenAdd: Math.max(0, addSeen - WINDOW_ROWS_PER_SIDE),
  };
}

/** A refused diff still says how much moved: the card falls back to whole-content. */
function degraded(reason: DiffDegradation, original: string, content: string): RewriteWindows {
  return {
    windows: [],
    hidden: { del: 0, replace: 0, merge: 0, add: 0, punct: 0 },
    hiddenTotal: 0,
    summary: {
      deletedBlocks: 0,
      deletedChars: 0,
      mergeCount: 0,
      replaceCount: 0,
      addedBlocks: 0,
      punctCount: 0,
    },
    addedChars: content.length,
    removedChars: original.length,
    empty: original === content,
    degraded: reason,
  };
}
