/**
 * A small yes/no dialog, for the destructive actions that used to reach for
 * `window.confirm()`.
 *
 * The native dialog is the one surface in the app the design system cannot
 * touch — it renders in the OS chrome, ignores the theme, and on macOS drops a
 * sheet over the whole window. This gives the same guard rail in the app's own
 * vocabulary.
 *
 * Built on `ModalShell`, so it inherits the portal, the mousedown-origin
 * backdrop guard, the modal stack (only the topmost dialog answers Escape) and
 * the IME guard. Anything the shell already solves is not re-solved here.
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./ModalShell";
import styles from "./ConfirmDialog.module.css";

interface Props {
  title: string;
  /** The consequence, spelled out. Wraps freely — don't pre-truncate it. */
  message: string;
  /** Verb for the action being confirmed ("删除"), not a bare "确定". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Paints the confirm button as destructive. */
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useTranslation();

  // Focus the safe option, not the destructive one: Enter should never be the
  // key that deletes something the author only glanced at.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose}>
      <div className={styles.panel} role="alertdialog" aria-modal="true" aria-label={title}>
        <div className={styles.title}>{title}</div>
        <div className={styles.message}>{message}</div>
        <div className={styles.actions}>
          <button ref={cancelRef} className={styles.cancelBtn} onClick={onClose}>
            {cancelLabel ?? t("common.cancel")}
          </button>
          <button
            className={`${styles.confirmBtn} ${danger ? styles.confirmBtnDanger : ""}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
