/**
 * Two-way scroll linking, used by the split view to keep the editor and the
 * preview showing the same part of the document.
 *
 * The panes are aligned by **source line**, not by scroll percentage: the two
 * sides render the same lines at very different heights (a `# 标题` line
 * becomes a tall heading, an `![图]` line a whole image block), so equal
 * percentages put different paragraphs on screen. Each side supplies a
 * `ScrollMapping` — viewport top → fractional source line, and back — and the
 * link carries the line across. When no mapping is available (no anchors in
 * the preview yet, an empty document) it falls back to the old proportional
 * mirror, and the two extremes always snap: driver at its very top/bottom puts
 * the follower at its own.
 *
 * Split out of the component so the tricky parts — the anchor interpolation,
 * and suppressing the echo, where scrolling A programmatically moves B, whose
 * own scroll handler would then move A back and fight the user's drag — are
 * unit-testable. Layout can't be exercised in jsdom (scrollHeight is always 0
 * there), so the DOM contract is kept to the small interfaces below and the
 * tests drive fakes.
 */

/** The slice of an element this module touches. */
export interface Scrollable {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(type: "scroll", listener: () => void, options?: { passive?: boolean }): void;
  removeEventListener(type: "scroll", listener: () => void): void;
}

/** One pane's line ↔ scroll-position translation (see lib/editor/scrollAnchors). */
export interface ScrollMapping {
  /**
   * The fractional source line (0-based) currently at this pane's viewport
   * top, or null when it can't be known (nothing rendered yet).
   */
  lineAtTop(): number | null;
  /**
   * Scroll this pane so the given fractional source line sits at its viewport
   * top. False means it had nothing to aim with — the caller falls back to
   * proportional mirroring.
   */
  scrollToLine(line: number): boolean;
}

export interface LinkScrollOptions {
  /**
   * How long after the last scroll event the driving side keeps its claim, in
   * ms. Long enough to cover the echo from the side being driven, short enough
   * that letting go of one pane and grabbing the other feels immediate.
   */
  releaseMs?: number;
  /** Line mapping for pane `a` / pane `b`. Both present ⇒ line-based sync. */
  mapA?: ScrollMapping;
  mapB?: ScrollMapping;
  /** Injectable timers so tests don't have to wait in real time. */
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (handle: number) => void;
}

// ── Anchor interpolation ──────────────────────────────────────────────────────

/**
 * One rendered block's place in both spaces: which source lines it came from
 * (markdown-it's token.map, 0-based, end exclusive) and where it landed in the
 * pane's scroll content, in px. The list a mapping works over must ascend in
 * both `line` and `top` — which stamping only top-level blocks guarantees,
 * since their line ranges are disjoint and their boxes stack in order.
 */
export interface LineAnchor {
  line: number;
  endLine: number;
  top: number;
  bottom: number;
}

/** Index of the last anchor whose `key` is <= value, or -1. */
function lastAtOrBelow(anchors: readonly LineAnchor[], key: "top" | "line", value: number): number {
  let lo = 0;
  let hi = anchors.length - 1;
  if (anchors[0][key] > value) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (anchors[mid][key] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The fractional source line sitting at content offset `y`.
 *
 * Inside a block, interpolate across its [line, endLine) span — that is what
 * keeps a 200-line fence or list scrolling smoothly instead of jumping at its
 * edges. Between blocks (margins, or a block that renders without an anchor,
 * e.g. display math), interpolate the skipped lines across the gap. Above the
 * first anchor (the pane's leading padding), ramp from line 0; past the last,
 * clamp to its end.
 */
export function lineAtOffset(anchors: readonly LineAnchor[], y: number): number | null {
  if (anchors.length === 0) return null;
  const i = lastAtOrBelow(anchors, "top", y);
  if (i < 0) {
    const first = anchors[0];
    if (first.top <= 0 || first.line <= 0) return first.line;
    return (Math.max(y, 0) / first.top) * first.line;
  }
  const a = anchors[i];
  if (y < a.bottom) {
    const height = a.bottom - a.top;
    if (height <= 0) return a.line;
    return a.line + ((y - a.top) / height) * (a.endLine - a.line);
  }
  const next = anchors[i + 1];
  if (!next) return a.endLine;
  const gap = next.top - a.bottom;
  const lines = next.line - a.endLine;
  if (gap <= 0 || lines <= 0) return next.line;
  return a.endLine + ((y - a.bottom) / gap) * lines;
}

/** The content offset where fractional source line `line` sits. Inverse of `lineAtOffset`. */
export function offsetAtLine(anchors: readonly LineAnchor[], line: number): number | null {
  if (anchors.length === 0) return null;
  const i = lastAtOrBelow(anchors, "line", line);
  if (i < 0) {
    const first = anchors[0];
    if (first.line <= 0 || first.top <= 0) return Math.max(first.top, 0);
    return (Math.max(line, 0) / first.line) * first.top;
  }
  const a = anchors[i];
  if (line < a.endLine) {
    const lines = a.endLine - a.line;
    if (lines <= 0) return a.top;
    return a.top + ((line - a.line) / lines) * (a.bottom - a.top);
  }
  const next = anchors[i + 1];
  if (!next) return a.bottom;
  const gap = next.top - a.bottom;
  const lines = next.line - a.endLine;
  if (gap <= 0 || lines <= 0) return next.top;
  return a.bottom + ((line - a.endLine) / lines) * gap;
}

/**
 * Link two scrollers so each follows the other proportionally.
 * Returns a cleanup that detaches both listeners and cancels any pending
 * release — safe to call more than once.
 */
export function linkScrollers(
  a: Scrollable,
  b: Scrollable,
  options: LinkScrollOptions = {},
): () => void {
  const releaseMs = options.releaseMs ?? 80;
  const setT = options.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearT = options.clearTimeout ?? ((h) => window.clearTimeout(h));

  // Which side the user is currently driving. While it's set, the other side's
  // handler is ignored, so the programmatic write below can't bounce back.
  let driver: Scrollable | null = null;
  let release: number | null = null;
  let detached = false;

  const follow = (
    from: Scrollable,
    to: Scrollable,
    fromMap: ScrollMapping | undefined,
    toMap: ScrollMapping | undefined,
  ) => () => {
    if (detached) return;
    if (driver && driver !== from) return;
    driver = from;

    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    // A pane with nothing to scroll has no position to mirror. Bail rather
    // than dividing by zero and writing NaN into scrollTop.
    if (fromMax > 0 && toMax > 0) {
      if (from.scrollTop <= 0) {
        // The extremes snap before any mapping runs: each pane's leading
        // padding sits *outside* its line space, so mapping there would leave
        // the follower shy of its own edge — and "I scrolled to the top and so
        // did the other pane" is the one alignment the author can verify at a
        // glance.
        to.scrollTop = 0;
      } else if (from.scrollTop >= fromMax - 1) {
        // -1: scrollTop clamps to fractional px on scaled displays, so the
        // driven extreme can sit just under its max forever.
        to.scrollTop = toMax;
      } else {
        let mapped = false;
        if (fromMap && toMap) {
          const line = fromMap.lineAtTop();
          if (line !== null) mapped = toMap.scrollToLine(line);
        }
        if (!mapped) to.scrollTop = (from.scrollTop / fromMax) * toMax;
      }
    }

    if (release !== null) clearT(release);
    release = setT(() => {
      release = null;
      driver = null;
    }, releaseMs);
  };

  const onA = follow(a, b, options.mapA, options.mapB);
  const onB = follow(b, a, options.mapB, options.mapA);
  a.addEventListener("scroll", onA, { passive: true });
  b.addEventListener("scroll", onB, { passive: true });

  return () => {
    if (detached) return;
    detached = true;
    a.removeEventListener("scroll", onA);
    b.removeEventListener("scroll", onB);
    if (release !== null) {
      clearT(release);
      release = null;
    }
    driver = null;
  };
}
