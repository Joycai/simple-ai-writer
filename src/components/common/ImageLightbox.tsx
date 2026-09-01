import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ImageOff, FolderOpen, Minus, Plus, X } from "lucide-react";
import { imageToDataUrl } from "../../lib/fs/images";
import { ModalShell, useModalClose } from "./ModalShell";
import styles from "./ImageLightbox.module.css";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const WHEEL_STEP = 1.15;
const BUTTON_STEP = 1.4;

interface View {
  scale: number;
  tx: number;
  ty: number;
}
const FIT: View = { scale: 1, tx: 0, ty: 0 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * A full-screen viewer for one local image, with wheel/button zoom and
 * drag-to-pan. Opened from any thumbnail whose only prior affordance was
 * "reveal in folder" — looking at the picture is the common want, so a click
 * now enlarges it and reaching the file on disk moves into the toolbar.
 *
 * Wraps {@link ModalShell} for the portal, the Escape-to-close stack, and the
 * exit animation; the zoom/pan interaction is self-contained here.
 */
export function ImageLightbox({ path, onClose }: { path: string; onClose: () => void }) {
  return (
    <ModalShell overlayClassName={styles.overlay} onClose={onClose} closeOnBackdrop={false}>
      <LightboxContent path={path} />
    </ModalShell>
  );
}

function LightboxContent({ path }: { path: string }) {
  const { t } = useTranslation();
  const close = useModalClose();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // Full resolution on purpose: the point of this view is to inspect the
  // pixels, so unlike the transcript thumbnail it reads the file at size.
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(false);
    imageToDataUrl(path)
      .then(({ dataUrl }) => { if (!cancelled) setUrl(dataUrl); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [path]);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(FIT);
  const [dragging, setDragging] = useState(false);
  // Latest view for the native wheel listener, which is bound once.
  const viewRef = useRef(view);
  viewRef.current = view;

  // Keep the image edges from being dragged inside the stage: at a given scale
  // the translation can move by at most half the overhang on each axis. When
  // the scaled image is smaller than the stage the limit is 0, so it stays
  // centred. Measured off the rendered (already fit-scaled) element, so it is
  // correct whatever the image's native size.
  const clampXY = useCallback((tx: number, ty: number, scale: number) => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img) return { tx, ty };
    const sr = stage.getBoundingClientRect();
    const maxX = Math.max(0, (img.offsetWidth * scale - sr.width) / 2);
    const maxY = Math.max(0, (img.offsetHeight * scale - sr.height) / 2);
    return { tx: clamp(tx, -maxX, maxX), ty: clamp(ty, -maxY, maxY) };
  }, []);

  // Zoom to `nextScale`, keeping the content point under (originX, originY)
  // fixed. With no origin it zooms about the stage centre. Returning to fit
  // recentres.
  const zoomTo = useCallback(
    (nextScale: number, originX?: number, originY?: number) => {
      setView((prev) => {
        const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
        if (scale === MIN_SCALE) return FIT;
        const stage = stageRef.current;
        let mx = 0;
        let my = 0;
        if (stage && originX != null && originY != null) {
          const sr = stage.getBoundingClientRect();
          mx = originX - (sr.left + sr.width / 2);
          my = originY - (sr.top + sr.height / 2);
        }
        const factor = scale / prev.scale;
        const nx = mx - factor * (mx - prev.tx);
        const ny = my - factor * (my - prev.ty);
        const c = clampXY(nx, ny, scale);
        return { scale, tx: c.tx, ty: c.ty };
      });
    },
    [clampXY],
  );

  // Native, non-passive wheel listener so the zoom can preventDefault and the
  // chat behind the overlay doesn't scroll. React's onWheel can't guarantee a
  // cancelable event here. Bound once; reads the live scale through viewRef.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      zoomTo(viewRef.current.scale * dir, e.clientX, e.clientY);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  // Drag-to-pan (only meaningful past fit). `moved` is a ref, not the
  // `dragging` state, because the click that follows pointerup fires before a
  // state update can land — so a pan released on empty scrim would otherwise
  // read `dragging` as already false and dismiss the viewer.
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const moved = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    moved.current = false;
    if (e.button !== 0 || view.scale <= 1) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved.current = true;
    setView((prev) => {
      const c = clampXY(d.tx + dx, d.ty + dy, prev.scale);
      return { ...prev, tx: c.tx, ty: c.ty };
    });
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const onStageClick = (e: React.MouseEvent) => {
    // A click on the empty scrim (not the image) closes — unless it was the
    // tail of a pan gesture.
    if (e.target === e.currentTarget && !moved.current) close?.();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (view.scale > 1) setView(FIT);
    else zoomTo(2, e.clientX, e.clientY);
  };

  const name = path.split(/[/\\]/).pop() ?? path;
  const stageClass = `${styles.stage} ${
    view.scale > 1 ? (dragging ? styles.stageGrabbing : styles.stageZoomable) : ""
  }`;

  return (
    <>
      <div
        ref={stageRef}
        className={stageClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onStageClick}
        onDoubleClick={onDoubleClick}
      >
        {error ? (
          <div className={styles.state}>
            <ImageOff size={30} strokeWidth={1.5} />
            <span>{t("editor.imageLoadError")}</span>
          </div>
        ) : url ? (
          <img
            ref={imgRef}
            src={url}
            alt={name}
            className={styles.img}
            draggable={false}
            style={{
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
              transition: dragging ? "none" : "transform 120ms var(--ease-out)",
            }}
          />
        ) : (
          <div className={styles.state}>
            <span className={styles.spinner} />
          </div>
        )}
      </div>

      {url && !error && <div className={styles.name}>{name}</div>}

      <button className={styles.closeBtn} onClick={() => close?.()} title={t("common.lightbox.close")}>
        <X size={17} strokeWidth={2} />
      </button>

      {url && !error && (
        <div className={styles.toolbar}>
          <button
            className={styles.toolBtn}
            onClick={() => zoomTo(view.scale / BUTTON_STEP)}
            disabled={view.scale <= MIN_SCALE}
            title={t("common.lightbox.zoomOut")}
          >
            <Minus size={16} strokeWidth={2} />
          </button>
          <button className={styles.zoomLabel} onClick={() => setView(FIT)} title={t("common.lightbox.reset")}>
            {Math.round(view.scale * 100)}%
          </button>
          <button
            className={styles.toolBtn}
            onClick={() => zoomTo(view.scale * BUTTON_STEP)}
            disabled={view.scale >= MAX_SCALE}
            title={t("common.lightbox.zoomIn")}
          >
            <Plus size={16} strokeWidth={2} />
          </button>
          <span className={styles.sep} />
          <button
            className={styles.toolBtn}
            onClick={() => void revealItemInDir(path)}
            title={t("ai.chat.revealImage")}
          >
            <FolderOpen size={16} strokeWidth={2} />
          </button>
        </div>
      )}
    </>
  );
}
