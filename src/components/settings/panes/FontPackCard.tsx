/**
 * A downloadable font scheme's card (设计稿 05n): the system font card plus a
 * status line that says whether the font is on this machine.
 *
 * Picking the card *is* the download — there is no second button — so the
 * card takes the selected state at once and grows a progress bar along its
 * bottom edge. Until the files land the preview draws in whatever the stack
 * falls back to, faded under a dashed border (05i's "absent" vocabulary),
 * rather than a picture of a font that isn't here.
 *
 * Not a single `<button>` like the system cards: the status line holds a
 * second control (删除 / 重试 / 清除), and a button can't contain a button. The
 * selecting part is its own button; the status actions sit beside it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, type FontPackState } from "../../../stores/appStore";
import type { FontPackId } from "../../../lib/theme/fontPacks";
import ui from "../settingsUi.module.css";
import a from "./Appearance.module.css";

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

export function FontPackCard({ id, labelKey, previewFont, fallbackLabelKey }: {
  id: FontPackId;
  labelKey: string;
  previewFont: string;
  /** The scheme deleting the pack in use falls back to — named in the confirmation. */
  fallbackLabelKey: string;
}) {
  const { t } = useTranslation();
  const pack: FontPackState = useAppStore((st) => st.fontPacks[id]);
  const active = useAppStore((st) => st.fontScheme === id);
  const setFontScheme = useAppStore((st) => st.setFontScheme);
  const downloadFontPack = useAppStore((st) => st.downloadFontPack);
  const removeFontPack = useAppStore((st) => st.removeFontPack);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);

  const here = pack.status === "ready";
  const downloading = pack.status === "downloading";
  const pct = pack.total > 0 ? Math.min(100, Math.floor((pack.done / pack.total) * 100)) : 0;

  // The confirmation only exists for the pack in use and only while it is here.
  // Once either stops being true it is gone for good — not waiting to pop back
  // up (and grab the focus) the next time this pack is picked.
  const showConfirm = confirming && here && active;
  useEffect(() => {
    if (confirming && !(here && active)) setConfirming(false);
  }, [confirming, here, active]);
  useEffect(() => {
    if (showConfirm) cancelRef.current?.focus();
  }, [showConfirm]);

  const cancel = () => {
    setConfirming(false);
    // Back to where the author came from, not to the page body.
    requestAnimationFrame(() => deleteRef.current?.focus());
  };

  // Escape backs out of the confirmation wherever the focus is. The settings
  // page closes itself on an Escape that reaches `window`; a capture listener
  // there runs first and keeps it from getting that far.
  useEffect(() => {
    if (!showConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Immediate: the settings page's own listener sits on `window` too.
      e.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showConfirm]);

  // 清除: what a failed download left. No confirmation, even for the pack in
  // use — a pack that isn't here already draws in 黑's faces, so switching
  // the choice to 黑 changes nothing on screen (docs/feature/downloadable-fonts-plan.md §5).
  const leftover = !here && !downloading ? pack.leftover ?? 0 : 0;
  const clear =
    leftover > 0 ? (
      <button
        type="button"
        className={a.packAction}
        title={t("systemSettings.appearance.fontPackClearTitle", { size: mb(leftover) })}
        onClick={() => {
          void removeFontPack(id);
          // The button is about to go; the card's own button stays.
          requestAnimationFrame(() => selectRef.current?.focus());
        }}
      >
        {t("systemSettings.appearance.fontPackClear")}
      </button>
    ) : null;

  const onDelete = () => {
    // Deleting the pack in use also changes the author's choice — show that first.
    if (active) setConfirming(true);
    else void removeFontPack(id);
  };

  let status: ReactNode;
  if (showConfirm) {
    status = (
      <div className={a.packConfirm}>
        <div className={a.packConfirmText}>{t("systemSettings.appearance.fontPackConfirm", { fallback: t(fallbackLabelKey) })}</div>
        <div className={a.packConfirmActions}>
          <button
            type="button"
            className={`${a.packButton} ${a.packButtonDanger}`}
            onClick={() => {
              setConfirming(false);
              void removeFontPack(id);
              // The status line is about to change under the focus; the card's own button stays.
              requestAnimationFrame(() => selectRef.current?.focus());
            }}
          >
            {t("systemSettings.appearance.fontPackDelete")}
          </button>
          <button type="button" ref={cancelRef} className={a.packButton} onClick={cancel}>
            {t("systemSettings.appearance.fontPackCancel")}
          </button>
        </div>
      </div>
    );
  } else {
    let left: ReactNode = " ";
    let right: ReactNode = null;
    let tone = "";
    if (downloading) {
      tone = a.packStatusBusy;
      // "2.6 / 6.1 MB" — one unit for the pair (03-ui-spec).
      left = t("systemSettings.appearance.fontPackDownloading", { pct, done: (pack.done / 1e6).toFixed(1), total: mb(pack.total) });
    } else if (here) {
      left = t("systemSettings.appearance.fontPackReady", { size: mb(pack.total) });
      right = (
        <button type="button" ref={deleteRef} className={a.packAction} onClick={onDelete}>
          {t("systemSettings.appearance.fontPackDelete")}
        </button>
      );
    } else if (pack.status === "error") {
      tone = a.packStatusError;
      left = t(`systemSettings.appearance.fontPackErr${pack.error === "integrity" ? "Integrity" : pack.error === "disk" ? "Disk" : "Network"}`);
      right = (
        <span className={a.packActions}>
          {/* Retries the download only — a failed pack the author has since moved
              away from must not take the font choice back with it. */}
          <button type="button" className={`${a.packAction} ${a.packActionAccent}`} onClick={() => void downloadFontPack(id)}>
            {t("systemSettings.appearance.fontPackRetry")}
          </button>
          {clear}
        </span>
      );
    } else if (leftover > 0 && pack.total > 0) {
      // Absent, with a failed download's files still here (the error itself
      // doesn't outlive a restart). A pick resumes from them.
      left = t("systemSettings.appearance.fontPackPartial", { done: (leftover / 1e6).toFixed(1), total: mb(pack.total) });
      right = clear;
    } else if (pack.total > 0) {
      // Absent. Before the startup disk read lands `total` is still 0 — show nothing rather than "0.0 MB".
      left = `↓ ${mb(pack.total)}`;
      right = <span className={a.packHint}>{t("systemSettings.appearance.fontPackAbsent")}</span>;
    }
    status = (
      <div className={`${a.packStatus} ${tone}`}>
        {/* The line ellipsizes in a narrow card; the whole sentence stays reachable. */}
        <span className={a.packStatusText} title={typeof left === "string" ? left : undefined}>{left}</span>
        {right}
      </div>
    );
  }

  return (
    <div
      className={`${ui.card} ${ui.fontCard} ${a.packCard} ${active ? ui.cardActive : ""} ${here || active ? "" : a.packAbsent}`}
      aria-busy={downloading || undefined}
    >
      <button
        type="button"
        ref={selectRef}
        className={a.packSelect}
        aria-pressed={active}
        title={here ? undefined : t("systemSettings.appearance.fontPackFallbackTitle")}
        // A failed pack's card retries on a click, like its 重试; a downloading
        // one just stays chosen (the running download is joined, not restarted).
        onClick={() => setFontScheme(id)}
      >
        <span className={`${ui.fontSample} ${here ? "" : a.packFaded}`} style={{ fontFamily: previewFont }}>文字 Aa</span>
        <span className={`${a.fontLine} ${here ? "" : a.packFaded}`} style={{ fontFamily: previewFont }}>
          {t("systemSettings.appearance.fontSampleLine")}
        </span>
        <span className={ui.cardName}>{t(labelKey)}</span>
      </button>
      {status}
      {downloading && (
        <div
          className={a.packProgress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t("systemSettings.appearance.fontPackProgress", { name: t(labelKey) })}
        >
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

