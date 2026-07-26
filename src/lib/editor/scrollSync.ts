/**
 * Two-way proportional scroll linking, used by the split view to keep the
 * editor and the preview at the same relative position.
 *
 * Split out of the component so the tricky part — suppressing the echo, where
 * scrolling A programmatically moves B, whose own scroll handler would then
 * move A back and fight the user's drag — is unit-testable. Layout can't be
 * exercised in jsdom (scrollHeight is always 0 there), so the DOM contract is
 * kept to the four members below and the tests drive fakes.
 */

/** The slice of an element this module touches. */
export interface Scrollable {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(type: "scroll", listener: () => void, options?: { passive?: boolean }): void;
  removeEventListener(type: "scroll", listener: () => void): void;
}

export interface LinkScrollOptions {
  /**
   * How long after the last scroll event the driving side keeps its claim, in
   * ms. Long enough to cover the echo from the side being driven, short enough
   * that letting go of one pane and grabbing the other feels immediate.
   */
  releaseMs?: number;
  /** Injectable timers so tests don't have to wait in real time. */
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (handle: number) => void;
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

  const follow = (from: Scrollable, to: Scrollable) => () => {
    if (detached) return;
    if (driver && driver !== from) return;
    driver = from;

    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    // A pane with nothing to scroll has no position to mirror. Bail rather
    // than dividing by zero and writing NaN into scrollTop.
    if (fromMax > 0 && toMax > 0) {
      to.scrollTop = (from.scrollTop / fromMax) * toMax;
    }

    if (release !== null) clearT(release);
    release = setT(() => {
      release = null;
      driver = null;
    }, releaseMs);
  };

  const onA = follow(a, b);
  const onB = follow(b, a);
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
