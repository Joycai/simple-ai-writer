import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Code2, ShieldCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useImeGuard } from "../../lib/ime";
import { ModalShell, useModalClose } from "../common/ModalShell";
import styles from "./SessionPermissionsMenu.module.css";

interface Props { enabled: boolean; onChange: (enabled: boolean) => void }

/** Presentation only. The owner supplies the captured chat's grant, never a
 * global preference. Remount with the chat key to dismiss a stale confirmation. */
export function SessionPermissionsMenu({ enabled, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const restoreFocus = () => trigger.current?.focus();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = panel.current?.offsetWidth ?? 320;
      const height = panel.current?.offsetHeight ?? 200;
      setPosition({
        left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - height - 12)),
      });
    };
    place();
    toggle.current?.focus();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); restoreFocus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <>
    <button ref={trigger} className={styles.trigger} data-enabled={enabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      <ShieldCheck size={15} aria-hidden="true" />
      {t(enabled ? "sessionPermissions.active" : "sessionPermissions.title")}
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} id={id} className={styles.menu} style={position} role="dialog" aria-label={t("sessionPermissions.title")}>
      <div className={styles.caption}>{t("sessionPermissions.scope")}</div>
      <button ref={toggle} className={styles.option} role="switch" aria-checked={enabled} aria-label={t("sessionPermissions.code")} onClick={() => {
        setOpen(false);
        if (enabled) { onChange(false); restoreFocus(); } else setConfirm(true);
      }}>
        <Code2 size={18} aria-hidden="true" />
        <span className={styles.optionText}><strong>{t("sessionPermissions.code")}</strong><small>{t("sessionPermissions.summary")}</small></span>
        <span className={styles.switchTrack} data-enabled={enabled} aria-hidden="true"><i /></span>
      </button>
      <p className={styles.note}>{t("sessionPermissions.other")}</p>
    </div>, document.body)}
    {confirm && <ModalShell overlayClassName={styles.overlay} onClose={() => { setConfirm(false); restoreFocus(); }}>
      <PermissionConfirmation onConfirm={() => onChange(true)} />
    </ModalShell>}
  </>;
}

function PermissionConfirmation({ onConfirm }: { onConfirm: () => void }) {
  const { t } = useTranslation();
  const close = useModalClose();
  const ime = useImeGuard();
  const cancel = useRef<HTMLButtonElement>(null);
  const accept = useRef<HTMLButtonElement>(null);
  const committed = useRef(false);
  const titleId = useId();
  const detailId = useId();
  useEffect(() => { cancel.current?.focus(); }, []);
  return <div className={styles.confirmation} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={detailId} {...ime.imeProps} onKeyDown={event => {
    if (event.key === "Escape") {
      // Consume before window shortcuts can close the owning chat drawer.
      event.stopPropagation();
      if (!ime.isComposing(event)) { event.preventDefault(); close?.(); }
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();
    if (document.activeElement === cancel.current) accept.current?.focus(); else cancel.current?.focus();
  }}>
    <Code2 className={styles.confirmIcon} size={24} aria-hidden="true" />
    <h2 id={titleId}>{t("sessionPermissions.confirmTitle")}</h2>
    <div id={detailId} className={styles.details}>
      <p>{t("sessionPermissions.coverage")}</p>
      <p className={styles.trust}>{t("sessionPermissions.trust")}</p>
      <p>{t("sessionPermissions.lifetime")}</p>
      <p>{t("sessionPermissions.pending")}</p>
    </div>
    <div className={styles.actions}>
      <button ref={cancel} className={styles.cancel} onClick={() => close?.()}>{t("common.cancel")}</button>
      <button ref={accept} className={styles.accept} onClick={() => { if (committed.current) return; committed.current = true; onConfirm(); close?.(); }}>{t("sessionPermissions.enable")}</button>
    </div>
  </div>;
}

export function SessionPermissionsBand({ onDisable }: { onDisable: () => void }) {
  const { t } = useTranslation();
  return <div className={styles.band} role="status">
    <Code2 size={15} aria-hidden="true" /><span>{t("sessionPermissions.band")}</span>
    <button onClick={onDisable} aria-label={t("sessionPermissions.disable")} title={t("sessionPermissions.disableHint")}><X size={14} aria-hidden="true" /></button>
  </div>;
}
