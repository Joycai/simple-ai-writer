import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ZoomIn, ZoomOut } from "lucide-react";
import { renderMarkdown } from "../../lib/fs/markdown";
import { useAppStore } from "../../stores/appStore";
import {
  formatPreviewZoom,
  PREVIEW_ZOOM_DEFAULT,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
} from "../../lib/editor/previewZoom";
import { imageToDataUrl } from "../../lib/fs/images";
import { resolveLinkPath } from "../../lib/paths";
import { annotateCitations } from "../../lib/lore/citations";
import { useLoreStore } from "../../stores/loreStore";
import { MD_BODY_CLASS } from "../../lib/theme/markdownThemes";
import styles from "./Preview.module.css";

interface Props {
  source: string;
  /** Directory of the source file, used to resolve relative image links. */
  basePath?: string | null;
}

/**
 * How long typing must pause before the preview rebuilds. Same idea as
 * HtmlPreview's REBUILD_DEBOUNCE_MS: a full markdown-it parse (linkify +
 * typographer + KaTeX) plus an innerHTML swap of the whole document is fine
 * once, but per keystroke it scales with document length — a novel chapter
 * froze the editor for the parse on every character. Slightly shorter than
 * the HTML pane's 400ms since nothing here restarts scripts.
 */
const TYPING_DEBOUNCE_MS = 300;

export function Preview({ source, basePath }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const zoom = useAppStore((s) => s.previewZoom);
  const setZoom = useAppStore((s) => s.setPreviewZoom);
  const stepZoom = useAppStore((s) => s.stepPreviewZoom);

  // ⌘/Ctrl + wheel over the page, the gesture every reader already knows.
  //
  // A native listener with `passive: false` rather than React's `onWheel`:
  // React registers wheel handlers on the root as passive, so `preventDefault`
  // there is ignored — and without it the webview runs its own page zoom on
  // top of ours, scaling the whole app chrome along with the manuscript.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      useAppStore.getState().stepPreviewZoom(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // The source the DOM currently shows. Trails `source` by the debounce while
  // the author types; a *different document* (basePath change) applies at once
  // so the old document's text is never resolved against the new folder.
  const [shown, setShown] = useState(source);
  const [prevBase, setPrevBase] = useState(basePath);
  if (prevBase !== basePath) {
    setPrevBase(basePath);
    setShown(source);
  }
  useEffect(() => {
    if (shown === source) return;
    const id = window.setTimeout(() => setShown(source), TYPING_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [source, shown]);
  /**
   * Decoded pictures, by absolute path — the value once it has landed, or the
   * in-flight read that will produce it.
   *
   * This effect re-runs on **every debounced rebuild** in split view (the whole
   * DOM is rebuilt from `shown`), so without a cache each rebuild meant
   * re-reading every illustration off disk and base64-encoding it again, and
   * each rebuilt `<img>` showed a broken icon until that landed — an
   * illustrated chapter visibly flickered as you wrote in it. A hit is applied
   * synchronously, before the browser ever paints the new element.
   */
  const decoded = useRef(new Map<string, string | Promise<string>>());

  // Another document is another neighbourhood of files; keeping the old one's
  // decoded pictures would just be megabytes nobody is going to ask for.
  useEffect(() => { decoded.current.clear(); }, [basePath]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = renderMarkdown(shown);

    // Mark lore citations that don't resolve against the current index — the
    // visible half of the grounding audit (click navigation is app-global).
    annotateCitations(ref.current, useLoreStore.getState().index);

    // Resolve local image links into inline data URLs. The webview can't load
    // file paths directly (CSP + the base URL isn't the document's folder), so
    // for every relative/local <img> we read the referenced file relative to the
    // markdown file and inline it — same approach ImagePreview uses.
    if (basePath) {
      ref.current.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
        const raw = img.getAttribute("src") ?? "";
        if (!raw || /^(https?:|data:|blob:|ai-writer-asset:)/i.test(raw)) return;
        // Shared with the exporter (lib/paths) rather than decoded here: this
        // used `decodeURI`, which leaves reserved characters escaped, so a
        // document titled "第1章 & 终局" looked for a folder with a literal
        // "%26" in it and showed none of its illustrations — while the same
        // document exported fine.
        const abs = resolveLinkPath(basePath, raw);

        const hit = decoded.current.get(abs);
        if (typeof hit === "string") { img.src = hit; return; }
        // The `src` the renderer wrote is a relative path this webview cannot
        // load. Drop it now, or the browser spends the wait showing its own
        // broken-image icon; the CSS marks the gap instead.
        img.removeAttribute("src");
        img.setAttribute("data-loading", "true");

        const pending = hit ?? imageToDataUrl(abs).then(({ dataUrl }) => {
          decoded.current.set(abs, dataUrl);
          return dataUrl;
        });
        if (!hit) decoded.current.set(abs, pending);
        pending
          .then((dataUrl) => { img.removeAttribute("data-loading"); img.src = dataUrl; })
          .catch(() => {
            // Forgotten rather than remembered as broken: the author is most
            // likely mid-way through typing the path, or about to create the
            // file, and a cached failure would outlive the fix.
            decoded.current.delete(abs);
            img.removeAttribute("data-loading");
            img.setAttribute("data-broken", "true");
          });
      });
    }

    // Lazy-render Mermaid blocks
    const mermaidBlocks = ref.current.querySelectorAll<HTMLElement>("code.language-mermaid");
    if (mermaidBlocks.length === 0) return;

    import("mermaid").then(({ default: mermaid }) => {
      // Follow the app theme so diagrams aren't dark-on-white in light mode.
      const isLight = document.documentElement.getAttribute("data-theme") === "light";
      // securityLevel must stay "strict": "loose" permits raw HTML/click
      // handlers inside diagram labels, letting a malicious markdown file
      // inject script into the app webview.
      mermaid.initialize({ startOnLoad: false, theme: isLight ? "default" : "dark", securityLevel: "strict" });
      mermaidBlocks.forEach((block, i) => {
        const pre = block.parentElement;
        if (!pre) return;
        const def = block.textContent || "";
        const div = document.createElement("div");
        div.className = "mermaid";
        div.id = `mermaid-${Date.now()}-${i}`;
        pre.replaceWith(div);
        mermaid.render(div.id + "-svg", def).then(({ svg }) => {
          div.innerHTML = svg;
        });
      });
    });
    // `basePath` belongs here too: two documents in different folders can hold
    // identical text (a template, a duplicated draft), and without it the
    // second one would render the first one's pictures — or none at all.
  }, [shown, basePath]);

  // data-preview-scroller marks the element that actually scrolls (the one
  // carrying `overflow-y: auto` — no longer this component's root since the
  // zoom control moved outside it). EditorArea's split-view sync finds it by
  // this attribute rather than by firstElementChild, which is exactly why
  // adding that wrapper couldn't silently break scroll linking.
  //
  // The inner element holds the measure (max-width + auto margins) and the
  // markdown theme: themes set element margins outright, so centring each
  // rendered child individually would be a specificity fight the theme wins.
  return (
    // The wrapper exists so the zoom control can sit *outside* the scrolling
    // element: an absolutely positioned child of a scroller is placed against
    // its content, so the pill would drift away on the first scroll.
    <div className={styles.wrap}>
      <div
        className={styles.preview}
        data-preview-scroller
        ref={scrollerRef}
        // Consumed by .page for both the scale and the max-width that cancels
        // it out — see Preview.module.css.
        style={{ "--preview-zoom": zoom } as CSSProperties}
      >
        <div ref={ref} className={`${styles.page} ${MD_BODY_CLASS}`} data-ai-selection />
      </div>
      <div className={styles.zoom} role="group" aria-label={t("editor.zoom.label")}>
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => stepZoom(-1)}
          disabled={zoom <= PREVIEW_ZOOM_MIN}
          title={t("editor.zoom.out")}
          aria-label={t("editor.zoom.out")}
        >
          <ZoomOut size={13} />
        </button>
        <button
          type="button"
          className={styles.zoomValue}
          onClick={() => setZoom(PREVIEW_ZOOM_DEFAULT)}
          disabled={zoom === PREVIEW_ZOOM_DEFAULT}
          title={t("editor.zoom.reset")}
        >
          {formatPreviewZoom(zoom)}
        </button>
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => stepZoom(1)}
          disabled={zoom >= PREVIEW_ZOOM_MAX}
          title={t("editor.zoom.in")}
          aria-label={t("editor.zoom.in")}
        >
          <ZoomIn size={13} />
        </button>
      </div>
    </div>
  );
}
