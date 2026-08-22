import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamThrottle } from "../streamThrottle";

describe("createStreamThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the first schedule on the leading edge", () => {
    const apply = vi.fn();
    const s = createStreamThrottle(apply, 80);
    s.schedule();
    expect(apply).not.toHaveBeenCalled(); // still async — one macrotask away
    vi.advanceTimersByTime(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst into one apply per interval", () => {
    const apply = vi.fn();
    const s = createStreamThrottle(apply, 80);
    s.schedule();
    vi.advanceTimersByTime(0); // leading apply
    // 40 tokens over the next interval → exactly one more apply.
    for (let i = 0; i < 40; i++) {
      s.schedule();
      vi.advanceTimersByTime(2);
    }
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("flush applies what is pending immediately", () => {
    const apply = vi.fn();
    const s = createStreamThrottle(apply, 80);
    s.schedule();
    vi.advanceTimersByTime(0);
    s.schedule(); // pending, would land ~80ms later
    s.flush();
    expect(apply).toHaveBeenCalledTimes(2);
    // The timer is consumed — nothing fires later on its own.
    vi.advanceTimersByTime(1000);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("flush with nothing pending is a no-op", () => {
    const apply = vi.fn();
    const s = createStreamThrottle(apply, 80);
    s.flush();
    expect(apply).not.toHaveBeenCalled();
  });

  it("a schedule after a flush still waits out the interval", () => {
    const apply = vi.fn();
    const s = createStreamThrottle(apply, 80);
    s.schedule();
    s.flush(); // counts as the last apply
    s.schedule();
    vi.advanceTimersByTime(40);
    expect(apply).toHaveBeenCalledTimes(1); // not yet — 80ms haven't passed
    vi.advanceTimersByTime(40);
    expect(apply).toHaveBeenCalledTimes(2);
  });
});
