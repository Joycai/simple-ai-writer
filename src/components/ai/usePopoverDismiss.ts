import { useEffect, type RefObject } from "react";

/**
 * Outside-click and Escape dismissal for a composer popover.
 *
 * Escape is handled in the **capture** phase and stopped there: these popovers
 * open inside the AI drawer, and a bubbling Escape would close the drawer out
 * from under the author who only meant to put the little menu away.
 */
export function usePopoverDismiss(
  open: boolean,
  close: () => void,
  root: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close, root]);
}
