import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Monitor, RefreshCw } from "lucide-react";
import { inlineHtmlImages } from "../../lib/fs/htmlDoc";
import { openWithDefaultApp, previewHtmlWindow } from "../../lib/fs/fileio";
import { useEditorStore } from "../../stores/editorStore";
import styles from "./HtmlPreview.module.css";

/**
 * Rebuilding the frame on every keystroke would restart any script in the
 * page each time; the markdown pane can afford per-keystroke because its
 * render is inert DOM. Slightly above typing cadence, well below "laggy".
 */
const REBUILD_DEBOUNCE_MS = 400;

interface FrameProps {
  /** The HTML document text to render. */
  source: string;
  /** Directory the document's relative image links resolve against. */
  baseDir: string | null;
  /** Wait before rebuilding on a source change; 0 for static content. */
  debounceMs?: number;
  /** Bump to force a fresh document from the same source (re-runs scripts). */
  generation?: number;
  className?: string;
}

/**
 * The app's ONE containment boundary for AI-written HTML: every surface that
 * renders a project page — the editor's preview pane and the approval card —
 * goes through this component, so the sandbox parameters exist in exactly one
 * place (docs/html-artifact-plan.md §4).
 *
 * The document goes in through a `blob:` URL, and that choice is load-bearing:
 *   - `srcdoc` (and any same-origin injection) inherits the app window's CSP,
 *     whose `script-src 'self'` blocks the inline scripts these pages live on.
 *     A blob document is its own opaque origin, so its scripts run.
 *   - `sandbox="allow-scripts"` — and nothing more. No `allow-same-origin`
 *     (scripts must never reach the app's window, IPC, or Tauri API), no
 *     `allow-top-navigation`, no `allow-popups`.
 */
export function HtmlFrame({ source, baseDir, debounceMs = 0, generation = 0, className }: FrameProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const build = async () => {
      // A failed image walk shouldn't blank the preview — fall back to the
      // raw source (broken images show as broken, which is the truth).
      const html = await inlineHtmlImages(source, baseDir).catch(() => source);
      if (cancelled) return;
      const next = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      // Revoke the predecessor only once its replacement exists; the iframe
      // switches src in the same commit, so nothing still needs the old blob.
      setUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return next;
      });
    };
    const timer = debounceMs > 0 ? setTimeout(() => void build(), debounceMs) : null;
    if (!timer) void build();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [source, baseDir, debounceMs, generation]);

  // The last blob outlives the effect above (its cleanup only cancels the
  // *pending* rebuild), so unmount has to revoke it explicitly.
  const urlRef = useRef<string | null>(null);
  urlRef.current = url;
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  if (!url) return null;
  return (
    <iframe
      className={`${styles.frame} ${className ?? ""}`}
      src={url}
      sandbox="allow-scripts"
      title={t("editor.htmlPreview.title")}
    />
  );
}

interface Props {
  /** The document text as the editor holds it right now. */
  source: string;
  /** Absolute path of the .html file, or null before the load settles. */
  filePath: string | null;
}

/**
 * The editor area's preview pane for a project .html document — AI-generated
 * diagrams and promo pages, or any page the author keeps in the workspace.
 * A toolbar (refresh / open in system browser) around the sandboxed HtmlFrame.
 */
export function HtmlPreview({ source, filePath }: Props) {
  const { t } = useTranslation();
  // Bumped by the refresh button: same source, fresh document — the way to
  // restart an animation or re-run a page's scripts from the top.
  const [generation, setGeneration] = useState(0);

  const baseDir = filePath ? filePath.replace(/[/\\][^/\\]*$/, "") : null;

  // Both destinations read the file off disk — flush the editor's dirty
  // buffer first so they show what the author is looking at, not the last
  // autosave.
  const openVia = async (open: (path: string) => Promise<void>) => {
    if (!filePath) return;
    try {
      await useEditorStore.getState().saveNow();
      await open(filePath);
    } catch (e) {
      console.error("[HtmlPreview] open failed:", e);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <button
          className={styles.btn}
          onClick={() => setGeneration((g) => g + 1)}
          title={t("editor.htmlPreview.refresh")}
        >
          <RefreshCw size={11} />
          {t("editor.htmlPreview.refresh")}
        </button>
        <button
          className={styles.btn}
          onClick={() => void openVia(previewHtmlWindow)}
          disabled={!filePath}
          title={t("editor.htmlPreview.openWindow")}
        >
          <Monitor size={11} />
          {t("editor.htmlPreview.openWindow")}
        </button>
        <button
          className={styles.btn}
          onClick={() => void openVia(openWithDefaultApp)}
          disabled={!filePath}
          title={t("editor.htmlPreview.openInBrowser")}
        >
          <ExternalLink size={11} />
          {t("editor.htmlPreview.openInBrowser")}
        </button>
      </div>
      <HtmlFrame
        source={source}
        baseDir={baseDir}
        debounceMs={REBUILD_DEBOUNCE_MS}
        generation={generation}
      />
    </div>
  );
}
