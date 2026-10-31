interface MenuSize { width: number; height: number }
interface ThemeMenuLayout {
  viewport: MenuSize;
  anchor: { right: number; bottom: number };
  root: MenuSize;
  child: MenuSize;
  /** Parent item offset in the root panel, including its current scroll position. */
  rowOffset: number;
}

/** Every panel is clamped independently: stacked children can be taller than their parent. */
export function themeMenuPosition({ viewport, anchor, root, child, rowOffset }: ThemeMenuLayout) {
  const margin = 8;
  const clamp = (start: number, size: number, limit: number) => Math.max(margin, Math.min(start, limit - size - margin));
  const left = clamp(anchor.right - root.width, root.width, viewport.width);
  const top = clamp(anchor.bottom + 6, root.height, viewport.height);
  const rightFits = left + root.width + child.width + margin <= viewport.width;
  const leftFits = left - child.width >= margin;
  const stacked = !rightFits && !leftFits;
  return {
    left, top, stacked,
    childLeft: stacked ? left : rightFits ? left + root.width : left - child.width,
    childTop: clamp(stacked ? top : top + rowOffset, child.height, viewport.height),
  };
}
