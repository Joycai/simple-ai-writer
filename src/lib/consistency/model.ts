/**
 * 一致性检查 — the issue model, and the pure text work around it.
 *
 * A scan's finding is only useful if it can be *pointed at*: "林辰用了左手" is
 * an observation, "characters 4,210–4,218 of this chapter say 以左手" is
 * something the author can jump to, replace, or dismiss. So every issue carries
 * a verbatim quote, and locating that quote in the live document is what turns
 * the report into working buttons.
 *
 * The locate step lives here rather than in the scan because it has to re-run:
 * the author keeps writing while they work through the list, and an offset
 * resolved at scan time is stale by the third fix.
 */

import type { ReviewScope } from "./scope";

export type IssueSeverity = "conflict" | "warning";

/** A resolved position in the document the report was made against. */
export interface IssueRange {
  from: number;
  to: number;
}

export interface ConsistencyIssue {
  id: string;
  severity: IssueSeverity;
  /**
   * Which lens found it: a lore category id from the active profile, or
   * `"timeline"` for ordering/continuity findings, which belong to no entity.
   */
  category: string;
  /** Short label — "林辰惯用手". */
  title: string;
  /** Verbatim span from the document. What 跳到原文 and 应用建议 act on. */
  quote: string;
  /** What the knowledge base (or the earlier text) says instead. */
  reference: string;
  /** A replacement for `quote`. Absent when the model only flags, not fixes. */
  suggestion?: string;
  /** The entity this is about, when it is about one — enables 更新设定. */
  entityName?: string;
  /** Where that entity lives, resolved against the lore index at scan time. */
  entityDirPath?: string;
  /** Which window (0-based) of the checked document reported it. */
  window?: number;
  /**
   * Where the quote sat when the checker verified it — an absolute range in
   * the document as scanned. A *hint* for `locateIssue`, never the truth: the
   * author edits after the scan, and the truth is whatever the live text says.
   * What it buys is disambiguation — a quote that occurs twice in the document
   * is still pointable when the scan knows which occurrence it meant.
   */
  anchor?: IssueRange;
  /** 1-based line of `anchor.from` in the scanned text, for the card's `L118`. */
  line?: number;
}

/** A fact the checker verified and found consistent. */
export interface ConsistencyPass {
  label: string;
  entityName?: string;
  entityDirPath?: string;
  window?: number;
  line?: number;
}

export type WindowStatus = "pending" | "running" | "done" | "failed" | "aborted";

/** One window of the document, and how its check went. */
export interface WindowOutcome {
  index: number;
  from: number;
  to: number;
  status: WindowStatus;
  /** Findings + passes it recorded. */
  recorded: number;
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  /** The checker's closing line — the 总评 for this window. */
  summary: string;
  /** Why it failed, when it did. */
  error?: string;
  /** True when the run ended with nothing recorded and no parseable output — "没查成". */
  empty?: boolean;
}

export interface ConsistencyReport {
  issues: ConsistencyIssue[];
  /** Checks that came back clean — the collapsed 已通过 N 项 list. */
  passed: ConsistencyPass[];
  /** Total things the model reports having checked (issues + passes floor). */
  checkedCount: number;
  durationMs: number;
  /** The document this describes. A report is meaningless against another. */
  filePath: string | null;
  /** Length of the text the report was made against. */
  docChars: number;
  /** What the yardstick was — the report head says so (calibration, like 已通过). */
  scope: ReviewScope;
  focus: string;
  windows: WindowOutcome[];
  /** Chars past the last window the cap left unchecked (0 = whole document). */
  uncheckedFrom: number | null;
  /** The author stopped it. Whatever was recorded is still here. */
  aborted: boolean;
  /** Every window ended empty: nothing recorded, nothing parseable. Not a green tick. */
  emptyRun: boolean;
}

/**
 * Where a quote sits in the document right now, or null if it no longer does.
 *
 * Two passes, because a model transcribing a quote out of prose reliably
 * normalises whitespace and occasionally a quotation mark, and refusing to
 * locate on that basis would throw away most of a scan's value:
 *
 *   1. exact — the common case, and the only one that can be trusted verbatim.
 *   2. whitespace/quote-insensitive — matched over a stripped projection of the
 *      document, then mapped back to real offsets.
 *
 * Ambiguity is a non-answer: a quote occurring twice cannot be pointed at, and
 * replacing the wrong one is worse than replacing neither.
 */
export function locateQuote(doc: string, quote: string): IssueRange | null {
  const q = quote.trim();
  if (!q) return null;

  const first = doc.indexOf(q);
  if (first !== -1) {
    return doc.indexOf(q, first + 1) === -1 ? { from: first, to: first + q.length } : null;
  }

  // Fold the document to its significant characters, remembering where each
  // one came from, then search that. `map[i]` is the source offset of folded
  // character i.
  const map: number[] = [];
  let folded = "";
  for (let i = 0; i < doc.length; i++) {
    const ch = normalizeChar(doc[i]);
    if (ch === "") continue;
    folded += ch;
    map.push(i);
  }
  let foldedQuote = "";
  for (const ch of q) foldedQuote += normalizeChar(ch);
  if (!foldedQuote) return null;

  const hit = folded.indexOf(foldedQuote);
  if (hit === -1 || folded.indexOf(foldedQuote, hit + 1) !== -1) return null;
  const from = map[hit];
  // The last matched character's source offset, plus its own width.
  const to = map[hit + foldedQuote.length - 1] + 1;
  return { from, to };
}

/**
 * How far around the anchor the near-search looks, in chars — narrowest first.
 * Each ring is searched with the uniqueness rule, so a quote the document
 * repeats resolves at the ring where only the intended occurrence is in view.
 */
const ANCHOR_RINGS = [0, 200, 2_000];

/**
 * `locateQuote` with the scan-time anchor as a tie-breaker.
 *
 * Near first: the spot where the checker saw it, then widening rings around
 * it, so a quote that the document repeats elsewhere still resolves to the
 * occurrence the finding was about. Whole document last, for the author who
 * has since moved the passage. Every ring keeps the uniqueness rule *within the
 * region searched* — the anchor narrows the question, it never guesses.
 */
export function locateIssue(doc: string, issue: Pick<ConsistencyIssue, "quote" | "anchor">): IssueRange | null {
  const hint = issue.anchor;
  if (hint) {
    for (const ring of ANCHOR_RINGS) {
      const from = Math.max(0, hint.from - ring);
      const to = Math.min(doc.length, hint.to + ring);
      if (from >= to) continue;
      const near = locateQuote(doc.slice(from, to), issue.quote);
      if (near) return { from: near.from + from, to: near.to + from };
    }
  }
  return locateQuote(doc, issue.quote);
}

/**
 * The text now standing where the quote used to be — for the 「引文已找不到」
 * card's "附近现在是「…」" line. The anchor's own span in the live document,
 * trimmed to one line. Null without an anchor or when the document is shorter
 * than it.
 */
export function textNearAnchor(doc: string, issue: Pick<ConsistencyIssue, "anchor">, maxChars = 24): string | null {
  const hint = issue.anchor;
  if (!hint || hint.from >= doc.length) return null;
  const line = doc.slice(hint.from, Math.min(doc.length, hint.from + Math.max(maxChars, hint.to - hint.from)))
    .split("\n")[0]
    .trim();
  return line ? line.slice(0, maxChars) : null;
}

/** Drop whitespace; fold the quote marks models normalise away. */
function normalizeChar(ch: string): string {
  if (/\s/.test(ch)) return "";
  if (ch === "“" || ch === "”" || ch === "„") return '"';
  if (ch === "‘" || ch === "’") return "'";
  return ch;
}

/**
 * Apply several suggestions to one document in a single pass.
 *
 * Right-to-left, so an earlier fix can't shift the offsets of a later one —
 * and each quote is re-located against the live text first, so an issue whose
 * passage the author has since rewritten is skipped rather than mangled.
 * Returns the new text plus the ids that actually landed.
 */
export function applySuggestions(
  doc: string,
  issues: ConsistencyIssue[],
): { text: string; applied: string[] } {
  const edits = issues
    .filter((i) => i.suggestion !== undefined && i.suggestion !== i.quote)
    .map((issue) => ({ issue, range: locateIssue(doc, issue) }))
    .filter((e): e is { issue: ConsistencyIssue; range: IssueRange } => e.range !== null)
    .sort((a, b) => b.range.from - a.range.from);

  // Overlapping ranges can't both apply; the later one in document order wins
  // because it is applied first and the earlier is then re-checked against it.
  let text = doc;
  const applied: string[] = [];
  let lastFrom = Infinity;
  for (const { issue, range } of edits) {
    if (range.to > lastFrom) continue;
    text = text.slice(0, range.from) + issue.suggestion! + text.slice(range.to);
    applied.push(issue.id);
    lastFrom = range.from;
  }
  return { text, applied };
}

/**
 * Put the quote back where its suggestion landed — the 撤销 on an applied card.
 *
 * Symmetric with `applySuggestions`: the suggestion is what is now in the text,
 * so it is what gets located (near the anchor, uniquely), and the quote is what
 * replaces it. Null when the suggestion can no longer be found — the author
 * edited over it, and there is nothing honest to undo.
 */
export function revertSuggestion(doc: string, issue: ConsistencyIssue): string | null {
  if (!issue.suggestion) return null;
  const range = locateIssue(doc, { quote: issue.suggestion, anchor: issue.anchor });
  if (!range) return null;
  return doc.slice(0, range.from) + issue.quote + doc.slice(range.to);
}
