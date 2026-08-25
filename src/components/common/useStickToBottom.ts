import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

/**
 * Slack (px) at the bottom edge inside which the reader still counts as being
 * at the live end. A couple of lines' worth: the wheel rarely stops exactly on
 * the last pixel, and treating a one-notch nudge as "went looking for history"
 * would strand the transcript mid-stream.
 */
const EDGE = 40;

export interface StickToBottom {
  /** False once the reader has scrolled away from the newest content. */
  pinned: boolean;
  /** Follow the newest content — a no-op while the reader is reading back. */
  follow: () => void;
  /** Jump to the live end and resume following. */
  toBottom: () => void;
}

/**
 * Keeps a scroller parked at its newest content *unless the reader scrolled
 * away from it*.
 *
 * A streaming transcript grows on nearly every frame, and the naive
 * `scrollTop = scrollHeight` on each change makes the log unreadable while a
 * run is live: any attempt to scroll back is undone by the next chunk. So
 * following is a mode, not a reflex — it is armed while the view sits at the
 * bottom and disarmed the moment the reader leaves it, which is the only
 * evidence available that they are reading rather than watching.
 *
 * The armed flag lives in a ref, not just state: `follow()` runs in a layout
 * effect immediately after the content grew, well before React would have
 * delivered a re-render carrying a fresh state value.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>): StickToBottom {
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const arm = useCallback((next: boolean) => {
    pinnedRef.current = next;
    // Re-rendering the whole transcript on every scroll event would cost more
    // than the button it drives is worth.
    setPinned((prev) => (prev === next ? prev : next));
  }, []);

  const follow = useCallback(() => {
    const el = ref.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [ref]);

  const toBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Armed here rather than waiting for the scroll event this triggers: the
    // next chunk may land first, and it must already be followed.
    arm(true);
    el.scrollTop = el.scrollHeight;
  }, [ref, arm]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => arm(el.scrollHeight - el.clientHeight - el.scrollTop <= EDGE);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // Resizing the pane (drawer dragged, window resized) changes how much of the
    // transcript fits, so whether the end is on screen can change with no scroll
    // event at all — and a pane that shrinks while following must keep following.
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
      else measure();
    });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [ref, arm]);

  // Memoised so callers can put the handle straight in an effect's dependency
  // list without re-running it on every render of a streaming transcript.
  return useMemo(() => ({ pinned, follow, toBottom }), [pinned, follow, toBottom]);
}
