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
import { linkScrollers, type Scrollable } from "../editor/scrollSync";

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
