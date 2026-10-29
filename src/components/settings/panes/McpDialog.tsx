import { useEffect, useRef, useState, type ReactNode } from "react";
import { ModalShell } from "../../common/ModalShell";
import styles from "./McpManagement.module.css";
/** Settings-specific drawer focus scope; nested confirmation dialogs own their focus. */
export function McpDialog({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const [previous] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [previous]);
  return <ModalShell overlayClassName={styles.overlay} onClose={onClose} closeOnBackdrop={!busy} closeOnEscape={!busy}>
    <div ref={panel} tabIndex={-1} className={styles.drawer} role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
      if (event.key !== "Tab" || !panel.current?.contains(event.target as Node)) return;
      const controls = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(el => el.getClientRects().length > 0);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }}>{children}</div>
  </ModalShell>;
}
