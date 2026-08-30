/**
 * Unit tests for the split-view scroll link.
 *
 * These use fakes rather than real elements on purpose: the suite runs in the
 * `node` environment, and even under jsdom `scrollHeight` / `clientHeight` are
 * always 0 because there is no layout — the exact numbers this module divides
 * by. Fakes let the proportional mapping and the echo suppression be pinned
 * down; that a real `.cm-scroller` and the preview root are the elements passed
 * in is EditorArea's job, verified in a browser.
 */
import { describe, expect, it, vi } from "vitest";
import {
  lineAtOffset,
  linkScrollers,
  offsetAtLine,
  type LineAnchor,
  type Scrollable,
  type ScrollMapping,
} from "../editor/scrollSync";

/** A scrollable that dispatches real 'scroll' events when scrollTop is written. */
function fakeScroller(scrollHeight: number, clientHeight: number) {
  const listeners = new Set<() => void>();
  let top = 0;
  const el = {
    scrollHeight,
    clientHeight,
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      top = v;
      // Mirror the browser: assigning scrollTop fires scroll on that element.
      for (const l of [...listeners]) l();
    },
    addEventListener(_t: "scroll", l: () => void) {
      listeners.add(l);
    },
    removeEventListener(_t: "scroll", l: () => void) {
      listeners.delete(l);
    },
    listenerCount: () => listeners.size,
  };
  return el as Scrollable & { listenerCount: () => number };
}

/** Timers we can step manually, so the release window needs no real waiting. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    opts: {
      setTimeout: (fn: () => void) => {
        pending.set(next, fn);
        return next++;
      },
      clearTimeout: (h: number) => void pending.delete(h),
    },
    /** Fire everything currently scheduled. */
    flush() {
      for (const [h, fn] of [...pending]) {
        pending.delete(h);
        fn();
      }
    },
    size: () => pending.size,
  };
}

describe("linkScrollers", () => {
  it("mirrors position proportionally, not by pixel", () => {
    const a = fakeScroller(2000, 500); // max 1500
    const b = fakeScroller(5000, 500); // max 4500
    linkScrollers(a, b, manualTimers().opts);

    a.scrollTop = 750; // halfway down a
    expect(b.scrollTop).toBe(2250); // halfway down b, not 750
  });

  it("links both directions", () => {
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    const t = manualTimers();
    linkScrollers(a, b, t.opts);

    b.scrollTop = 4500; // drive from b this time
    expect(a.scrollTop).toBe(1500);

    t.flush(); // release b's claim
    a.scrollTop = 0;
    expect(b.scrollTop).toBe(0);
  });

  it("does not let the driven side echo back and fight the drag", () => {
    // Different extents, so an echo would land on a different value and be
    // visible as drift rather than a harmless no-op.
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    linkScrollers(a, b, manualTimers().opts);

    a.scrollTop = 300;
    expect(b.scrollTop).toBe(900);
    // a must still hold exactly what was written — b's scroll handler ran, saw
    // that a is driving, and did nothing.
    expect(a.scrollTop).toBe(300);
  });

  it("hands the claim over once the release window elapses", () => {
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    const t = manualTimers();
    linkScrollers(a, b, t.opts);

    a.scrollTop = 1500;
    expect(b.scrollTop).toBe(4500);

    // Before release, b is still ignored...
    b.scrollTop = 0;
    expect(a.scrollTop).toBe(1500);

    // ...after release, b can drive.
    t.flush();
    b.scrollTop = 2250;
    expect(a.scrollTop).toBe(750);
  });

  it("ignores a side with nothing to scroll instead of writing NaN", () => {
    const a = fakeScroller(2000, 500); // max 1500
    const shortB = fakeScroller(400, 500); // max negative — content fits
    linkScrollers(a, shortB, manualTimers().opts);

    a.scrollTop = 750;
    expect(shortB.scrollTop).toBe(0);
    expect(Number.isNaN(shortB.scrollTop)).toBe(false);

    // And driving from the pane that can't scroll must not corrupt the other.
    shortB.scrollTop = 0;
    expect(a.scrollTop).toBe(750);
  });

  it("handles an empty document on both sides", () => {
    const a = fakeScroller(0, 0);
    const b = fakeScroller(0, 0);
    linkScrollers(a, b, manualTimers().opts);
    a.scrollTop = 0;
    expect(Number.isNaN(b.scrollTop)).toBe(false);
    expect(b.scrollTop).toBe(0);
  });

  it("detaches both listeners and cancels the pending release on cleanup", () => {
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    const t = manualTimers();
    const stop = linkScrollers(a, b, t.opts);

    expect(a.listenerCount()).toBe(1);
    expect(b.listenerCount()).toBe(1);

    a.scrollTop = 750;
    expect(t.size()).toBe(1); // release scheduled

    stop();
    expect(a.listenerCount()).toBe(0);
    expect(b.listenerCount()).toBe(0);
    expect(t.size()).toBe(0); // and cancelled, so no timer outlives the view
  });

  it("stops syncing after cleanup", () => {
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    const stop = linkScrollers(a, b, manualTimers().opts);
    stop();
    a.scrollTop = 750;
    expect(b.scrollTop).toBe(0);
  });

  it("is safe to clean up twice", () => {
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    const stop = linkScrollers(a, b, manualTimers().opts);
    stop();
    expect(() => stop()).not.toThrow();
  });

  it("passes passive:true so scrolling is never blocked on the handler", () => {
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    const spyA = vi.spyOn(a, "addEventListener");
    linkScrollers(a, b, manualTimers().opts);
    expect(spyA).toHaveBeenCalledWith("scroll", expect.any(Function), { passive: true });
  });
});

describe("linkScrollers with line mappings", () => {
  /** A mapping whose calls are recorded, answering with canned values. */
  function fakeMap(line: number | null, accept = true) {
    const calls: { lineAtTop: number; scrollTo: number[] } = { lineAtTop: 0, scrollTo: [] };
    const map: ScrollMapping = {
      lineAtTop() {
        calls.lineAtTop++;
        return line;
      },
      scrollToLine(l) {
        calls.scrollTo.push(l);
        return accept;
      },
    };
    return { map, calls };
  }

  it("carries the driver's line across instead of the scroll percentage", () => {
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    const mapA = fakeMap(42.5);
    const mapB = fakeMap(null);
    linkScrollers(a, b, { ...manualTimers().opts, mapA: mapA.map, mapB: mapB.map });

    a.scrollTop = 750;
    expect(mapB.calls.scrollTo).toEqual([42.5]);
    // And no proportional write happened on top of the mapped one.
    expect(b.scrollTop).toBe(0);
  });

  it("falls back to proportional when the driver's line is unknowable", () => {
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    const mapA = fakeMap(null);
    const mapB = fakeMap(null);
    linkScrollers(a, b, { ...manualTimers().opts, mapA: mapA.map, mapB: mapB.map });

    a.scrollTop = 750;
    expect(mapB.calls.scrollTo).toEqual([]);
    expect(b.scrollTop).toBe(2250);
  });

  it("falls back to proportional when the follower has nothing to aim with", () => {
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    const mapA = fakeMap(42.5);
    const mapB = fakeMap(null, /* accept */ false);
    linkScrollers(a, b, { ...manualTimers().opts, mapA: mapA.map, mapB: mapB.map });

    a.scrollTop = 750;
    expect(mapB.calls.scrollTo).toEqual([42.5]);
    expect(b.scrollTop).toBe(2250);
  });

  it("snaps the extremes without consulting the mapping", () => {
    // Each pane's leading padding sits outside its line space, so mapping at
    // the edges would leave the follower shy of its own top/bottom.
    const a = fakeScroller(2000, 500);
    const b = fakeScroller(5000, 500);
    const t = manualTimers();
    const mapA = fakeMap(42.5);
    const mapB = fakeMap(null);
    linkScrollers(a, b, { ...t.opts, mapA: mapA.map, mapB: mapB.map });

    a.scrollTop = 1500; // a's max
    expect(b.scrollTop).toBe(4500);
    expect(mapA.calls.lineAtTop).toBe(0);

    t.flush();
    a.scrollTop = 0;
    expect(b.scrollTop).toBe(0);
    expect(mapA.calls.lineAtTop).toBe(0);
  });
});

describe("anchor interpolation", () => {
  // Three top-level blocks with a gap (an unanchored block, or plain margins)
  // between the second and third:
  //   lines [0,2)  → px [64, 164)
  //   lines [3,5)  → px [180, 280)
  //   lines [9,10) → px [400, 460)
  const anchors: LineAnchor[] = [
    { line: 0, endLine: 2, top: 64, bottom: 164 },
    { line: 3, endLine: 5, top: 180, bottom: 280 },
    { line: 9, endLine: 10, top: 400, bottom: 460 },
  ];

  it("interpolates inside a block across its full line span", () => {
    expect(lineAtOffset(anchors, 64)).toBe(0);
    expect(lineAtOffset(anchors, 114)).toBe(1); // halfway down a 2-line block
    expect(offsetAtLine(anchors, 1)).toBe(114);
    expect(offsetAtLine(anchors, 4)).toBe(230); // halfway down the second block
  });

  it("interpolates the skipped lines across the gap between blocks", () => {
    // Gap 280→400 px carries lines 5→9.
    expect(lineAtOffset(anchors, 340)).toBe(7);
    expect(offsetAtLine(anchors, 7)).toBe(340);
  });

  it("ramps the leading padding from line 0 and clamps past the end", () => {
    // First anchor starts at line 0, so everything above it is line 0…
    expect(lineAtOffset(anchors, 30)).toBe(0);
    expect(offsetAtLine(anchors, 0)).toBe(64);
    // …and past the last block there is nothing further to name.
    expect(lineAtOffset(anchors, 9999)).toBe(10);
    expect(offsetAtLine(anchors, 9999)).toBe(460);
  });

  it("ramps proportionally when the document starts with unanchored lines", () => {
    const late: LineAnchor[] = [{ line: 4, endLine: 6, top: 100, bottom: 200 }];
    expect(lineAtOffset(late, 50)).toBe(2);
    expect(offsetAtLine(late, 2)).toBe(50);
    expect(lineAtOffset(late, -10)).toBe(0);
    expect(offsetAtLine(late, -3)).toBe(0);
  });

  it("returns null with no anchors so the caller can fall back", () => {
    expect(lineAtOffset([], 100)).toBeNull();
    expect(offsetAtLine([], 3)).toBeNull();
  });

  it("survives a zero-height block without dividing by it", () => {
    const flat: LineAnchor[] = [{ line: 2, endLine: 4, top: 100, bottom: 100 }];
    // y is at (not before) the block, and the block is over at the same px —
    // the far edge, not NaN.
    expect(lineAtOffset(flat, 100)).toBe(4);
    expect(offsetAtLine(flat, 3)).toBe(100);
  });

  /**
   * The whole point of AnchorSource: the preview measures a block's rect only
   * when `at(i)` is called, so the number of probes per query IS the number of
   * layout reads per scroll event. If a change makes the interpolation walk
   * the list linearly, this stops being O(log n) and a 2000-block document is
   * back to 2000 rect reads per event.
   */
  it("consults O(log n) anchors per query through a lazy source, with array-identical results", () => {
    const n = 1024;
    const big: LineAnchor[] = Array.from({ length: n }, (_, i) => ({
      line: i * 3,
      endLine: i * 3 + 2,
      top: i * 40,
      bottom: i * 40 + 30,
    }));
    let probes = 0;
    const lazy = { length: n, at: (i: number) => (probes++, big[i]) };

    for (const y of [0, 35, 40_960 / 2, 40_930, 12_345]) {
      probes = 0;
      expect(lineAtOffset(lazy, y)).toBe(lineAtOffset(big, y));
      expect(probes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(n)) + 4);
    }
    for (const line of [0, 1.5, 1536, 3070, 777]) {
      probes = 0;
      expect(offsetAtLine(lazy, line)).toBe(offsetAtLine(big, line));
      expect(probes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(n)) + 4);
    }
  });
});
