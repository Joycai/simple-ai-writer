import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { readBinaryFile, openWithDefaultApp } from "../../lib/fs/fileio";
import { stepPreviewZoom } from "../../lib/editor/previewZoom";
import { pdfPageNumber, pdfPixelRatio } from "../../lib/editor/pdfViewport";
import styles from "./PdfPreview.module.css";

// Vite emits these locally, including CJK maps and JPEG2000 decoding resources.
// Resolve by exact packaged filename: no CDN or PDF-provided asset URL is used.
const assets = import.meta.glob<string>("/node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*", { eager: true, query: "?url&no-inline", import: "default" });
const assetDirs: Record<string, string> = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts", wasmUrl: "wasm" };
class LocalPdfData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const url = assets[`/node_modules/pdfjs-dist/${assetDirs[kind]}/${filename}`];
    if (!url) throw new Error(`Missing PDF resource: ${filename}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`PDF resource: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ path }: { path: string }) {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [zoom, setZoom] = useState<number | null>(null);
  const [effectiveZoom, setEffectiveZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let task: ReturnType<typeof getDocument> | undefined;
    setDoc(null);
    setError(null);
    setPage(1);
    setPageInput("1");
    void readBinaryFile(path).then(async (data) => {
      if (disposed) return;
      task = getDocument({ data, BinaryDataFactory: LocalPdfData, useWorkerFetch: false });
      // Password-protected files fail promptly; opening externally remains available.
      const loaded = await task.promise;
      if (!disposed) setDoc(loaded);
    }).catch((e: unknown) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; void task?.destroy().catch(() => {}); };
  }, [path, attempt]);

  const go = (value: number) => {
    const next = pdfPageNumber(value, doc?.numPages ?? 1, page);
    setPage(next);
    setPageInput(String(next));
    scroller.current?.scrollTo(0, 0);
  };

  return <div className={styles.root}>
    <div className={styles.toolbar} role="group" aria-label={t("pdf.controls")}>
      <button disabled={!doc || page <= 1} onClick={() => go(page - 1)}>{t("pdf.previous")}</button>
      <form onSubmit={(e) => { e.preventDefault(); go(Number(pageInput)); }}>
        <input aria-label={t("pdf.page")} inputMode="numeric" value={pageInput} disabled={!doc}
          onChange={(e) => setPageInput(e.target.value)} onBlur={() => go(Number(pageInput))} />
        <span> / {doc?.numPages ?? "—"}</span>
      </form>
      <button disabled={!doc || page >= doc.numPages} onClick={() => go(page + 1)}>{t("pdf.next")}</button>
      <button disabled={!doc || effectiveZoom <= 0.5} aria-label={t("pdf.zoomOut")} onClick={() => setZoom(stepPreviewZoom(effectiveZoom, -1))}>−</button>
      <button disabled={!doc} onClick={() => setZoom(1)}>{`${Math.round(effectiveZoom * 100)}%`}</button>
      <button disabled={!doc || effectiveZoom >= 3} aria-label={t("pdf.zoomIn")} onClick={() => setZoom(stepPreviewZoom(effectiveZoom, 1))}>+</button>
      <button disabled={!doc} aria-pressed={zoom === null} onClick={() => setZoom(null)}>{t("pdf.fit")}</button>
      <button onClick={() => void openWithDefaultApp(path).catch((e: unknown) => setError(String(e)))}>{t("editor.loadErrorOpenExternal")}</button>
    </div>
    {error && <div className={styles.message} role="alert">
      <p>{t("pdf.error")}</p><p>{error}</p>
      <button onClick={() => setAttempt((n) => n + 1)}>{t("editor.loadErrorRetry")}</button>
    </div>}
    <div ref={scroller} className={styles.scroller}>
      {!doc && !error && <p role="status">{t("pdf.loading")}</p>}
      {doc && width > 0 && <PdfPage key={`${attempt}:${page}:${zoom}:${width}`} doc={doc} page={page} zoom={zoom} width={width} onScale={setEffectiveZoom} />}
    </div>
  </div>;
}

function PdfPage({ doc, page, zoom, width, onScale }: { doc: PDFDocumentProxy; page: number; zoom: number | null; width: number; onScale: (scale: number) => void }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    let render: RenderTask | undefined;
    let text: TextLayer | undefined;
    const container = host.current!;
    // Each render owns fresh DOM, so a cancelled task never paints a newer page.
    const canvas = document.createElement("canvas");
    const layer = document.createElement("div");
    layer.className = styles.textLayer;
    container.replaceChildren(canvas, layer);
    void doc.getPage(page).then(async (pdfPage) => {
      if (disposed) return;
      try {
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = zoom ?? Math.max(0.05, (width - 32) / base.width);
        onScale(scale);
        const viewport = pdfPage.getViewport({ scale });
        // Bound GPU memory even for unusually large page boxes / Retina displays.
        const ratio = pdfPixelRatio(viewport.width, viewport.height, window.devicePixelRatio);
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;
        container.style.setProperty("--total-scale-factor", String(scale));
        render = pdfPage.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        await render.promise;
        if (disposed) return;
        text = new TextLayer({ container: layer, viewport, textContentSource: pdfPage.streamTextContent() });
        await text.render();
        if (!disposed) setLoading(false);
      } finally { pdfPage.cleanup(); }
    }).catch((e: unknown) => { if (!disposed) { setError(String(e)); setLoading(false); } });
    return () => { disposed = true; render?.cancel(); text?.cancel(); canvas.width = canvas.height = 0; container.replaceChildren(); };
  }, [doc, page, zoom, width, onScale]);
  return <>
    {loading && <p role="status">{t("pdf.loading")}</p>}
    {error && <p role="alert">{t("pdf.error")} {error}</p>}
    <div className={styles.page} ref={host} aria-label={t("pdf.pageNumber", { page })} />
  </>;
}
