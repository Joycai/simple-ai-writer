import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Whether an element is currently narrower than `at` pixels.
 *
 * The approval cards live in two hosts an order of magnitude apart — a 1100px
 * drawer and a rail the author can drag down to 160 — and the degradations the
 * design asks for are not all expressible in CSS: how many context lines to
 * keep and how many windows to draw change what is *built*, not just what is
 * shown, because the folded-away count has to be right either way.
 *
 * A media query would be wrong even for the CSS half: the window is wide while
 * the rail is narrow. This measures the element.
 */
export function useNarrow(ref: RefObject<HTMLElement | null>, at: number): boolean {
  const [narrow, setNarrow] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured before paint, so a card born in the rail never flashes its
    // wide layout on the way to its narrow one.
    setNarrow(el.clientWidth > 0 && el.clientWidth < at);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setNarrow(width < at);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, at]);

  return narrow;
}
