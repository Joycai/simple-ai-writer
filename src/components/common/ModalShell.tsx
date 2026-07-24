/**
 * Shared overlay shell for modal dialogs.
 *
 * Solves two ways an editing modal used to close by accident and lose work:
 *   1. A plain backdrop click. When `isDirty` is set, closing is gated behind a
 *      confirm() so in-progress edits aren't dropped on a stray click.
 *   2. A text-selection drag that starts inside the panel and is released on the
 *      backdrop. The old `onClick={onClose}` fired on that mouseup; here we only
 *      treat it as a backdrop dismissal when BOTH the press and the release land
 *      on the overlay itself (mousedown-origin guard).
 *
 * The overlay element keeps its per-modal class (blur/centering/z-index live in
 * each modal's CSS), so migrating a modal is just: drop the hand-rolled
 * `<div className={styles.overlay}>` + createPortal and wrap the panel here.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/**
 * Stack of mounted modals (topmost last). A global Escape listener would
 * otherwise fire on every open ModalShell at once — with nested modals that
 * closes the wrong one. Only the top of the stack reacts to Escape.
 */
const modalStack: object[] = [];

interface ModalShellProps {
  /** The modal's own overlay class — carries backdrop blur, centering, z-index. */
  overlayClassName: string;
  onClose: () => void;
  /** Panel (and any portaled siblings such as an @-picker). */
  children: ReactNode;
  /** When true, backdrop-click / Escape asks for confirmation before closing. */
  isDirty?: boolean;
  /** Overrides the default "discard unsaved changes?" confirm message. */
  confirmMessage?: string;
  /** Set false to ignore backdrop clicks entirely (e.g. while a task runs). Default true. */
  closeOnBackdrop?: boolean;
  /** Close on the Escape key (also gated by `isDirty`). Default true. */
  closeOnEscape?: boolean;
}

export function ModalShell({
  overlayClassName,
  onClose,
  children,
  isDirty = false,
  confirmMessage,
  closeOnBackdrop = true,
  closeOnEscape = true,
}: ModalShellProps) {
  const { t } = useTranslation();

  // Register in the modal stack for the lifetime of this instance so nested
  // modals can tell who is on top (see modalStack). Every instance registers —
  // even a non-Escape-closable one still blocks Escape from the modal beneath.
  const idRef = useRef<object>({});
  useEffect(() => {
    const id = idRef.current;
    modalStack.push(id);
    return () => {
      const i = modalStack.lastIndexOf(id);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, []);

  // Read the latest props inside stable event handlers without re-subscribing.
  const requestCloseRef = useRef<() => void>(() => {});
  requestCloseRef.current = () => {
    if (isDirty) {
      const msg = confirmMessage ?? t("common.unsavedConfirm", {
        defaultValue: "有尚未保存的更改，关闭后将丢失。确定关闭吗？",
      });
      if (!window.confirm(msg)) return;
    }
    onClose();
  };

  // Did the current mouse gesture start on the backdrop itself?
  const pressedBackdrop = useRef(false);

  const onMouseDown = (e: React.MouseEvent) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const releasedOnBackdrop = e.target === e.currentTarget;
    const wasBackdropGesture = pressedBackdrop.current && releasedOnBackdrop;
    pressedBackdrop.current = false;
    if (wasBackdropGesture && closeOnBackdrop) requestCloseRef.current();
  };

  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Only the topmost modal reacts, so a nested modal doesn't also close its parent.
      if (modalStack[modalStack.length - 1] !== idRef.current) return;
      requestCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOnEscape]);

  return createPortal(
    <div className={overlayClassName} onMouseDown={onMouseDown} onMouseUp={onMouseUp}>
      {children}
    </div>,
    document.body,
  );
}
