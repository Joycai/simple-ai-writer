import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./ContextMenu.module.css";

export type ContextMenuEntry =
  | {
      kind: "item";
      icon?: ReactNode;
      label: string;
      /** 标签下的一行 mono 小字——禁用项写「为什么禁用、去哪儿解」（设计稿 03f 屏 1b ④）。 */
      hint?: string;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      action: () => void;
    }
  | { kind: "divider" };

/**
 * App-styled right-click menu rendered in a portal (escapes overflow/transform
 * clipping). The overlay swallows the click that dismisses it; Escape and a
 * second right-click also close. Item actions run after the menu closes.
 */
export function ContextMenu({
  x, y, items, onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clamp into the viewport using an estimated menu size (items are fixed-height).
  const height = items.reduce(
    (h, it) => h + (it.kind === "divider" ? 9 : it.hint ? 44 : 30),
    10,
  );
  const left = Math.min(x, window.innerWidth - 204);
  const top = Math.min(y, window.innerHeight - height - 8);

  return createPortal(
    <div
      className={styles.overlay}
      data-context-menu
      onMouseDown={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      <div
        className={styles.menu}
        style={{ left, top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) =>
          it.kind === "divider" ? (
            <div key={i} className={styles.divider} />
          ) : (
            <button
              key={i}
              className={`${styles.item} ${it.danger ? styles.itemDanger : ""} ${it.hint ? styles.itemWithHint : ""}`}
              disabled={it.disabled}
              onClick={() => { onClose(); it.action(); }}
            >
              {it.icon}
              <span className={styles.label}>
                {it.label}
                {it.hint && <span className={styles.hint}>{it.hint}</span>}
              </span>
              {it.shortcut && <span className={styles.shortcut}>{it.shortcut}</span>}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
