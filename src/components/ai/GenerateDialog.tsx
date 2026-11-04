import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useImeGuard } from "../../lib/ime";
import styles from "./AiPanel.module.css";

/** Native modality keeps keyboard focus inside the picker and restores its opener. */
export function GenerateDialog({ title, onClose, children }: {
  title: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const ime = useImeGuard();
  const backdropPress = useRef(false);
  const { t } = useTranslation();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>('input[type="search"], input:not([type])')?.focus();
    return () => { dialog.close(); opener?.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={ref} className={styles.generateDialog} aria-labelledby={id} {...ime.imeProps}
    onMouseDown={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      backdropPress.current = event.target === event.currentTarget && (
        event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom
      );
    }}
    onMouseUp={event => {
      if (backdropPress.current && event.target === event.currentTarget) onClose();
      backdropPress.current = false;
    }}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      // React portals still bubble into AiPanel: never let Cmd/Ctrl+Enter in
      // a picker execute the request underneath the modal.
      event.stopPropagation();
      if (event.key === "Escape" && ime.isComposing(event)) event.preventDefault();
    }}>
    <header className={styles.generateHeader}><strong id={id}>{title}</strong>
      <button type="button" className={styles.linkBtn} onClick={onClose} aria-label={t("common.close")}><X size={16} /></button>
    </header>
    <div className={styles.generateDialogBody}>{children}</div>
  </dialog>, document.body);
}
