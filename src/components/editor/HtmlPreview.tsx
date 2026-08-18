import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw } from "lucide-react";
import { inlineHtmlImages } from "../../lib/fs/htmlDoc";
import { openWithDefaultApp } from "../../lib/fs/fileio";
import { useEditorStore } from "../../stores/editorStore";
import styles from "./HtmlPreview.module.css";

interface Props {
  /** The document text as the editor holds it right now. */
  source: string;
  /** Absolute path of the .html file, or null before the load settles. */
  filePath: string | null;
}

/**
 * Rebuilding the frame on every keystroke would restart any script in the
 * page each time; the markdown pane can afford per-keystroke because its
 * render is inert DOM. Slightly above typing cadence, well below "laggy".
 */
const REBUILD_DEBOUNCE_MS = 400;

/**
 * Sandboxed preview for a project .html document — AI-generated diagrams and
 * promo pages, or any page the author keeps in the workspace.
 *
 * The document goes in through a `blob:` URL, and that choice is load-bearing:
 *   - `srcdoc` (and any same-origin injection) inherits the app window's CSP,
 *     whose `script-src 'self'` blocks the inline scripts these pages live on.
 *     A blob document is its own opaque origin, so its scripts run.
 *   - `sandbox="allow-scripts"` — and nothing more. No `allow-same-origin`
 *     (scripts must never reach the app's window, IPC, or Tauri API), no
 *     `allow-top-navigation`, no `allow-popups`. This is the app's one
 *     containment boundary for AI-written script; approval cards will reuse
 *     this component so the parameters can't drift apart (see
 *     docs/html-artifact-plan.md).
 */
export function HtmlPreview({ source, filePath }: Props) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  // Bumped by the refresh button: same source, fresh document — the way to
  // restart an animation or re-run a page's scripts from the top.
  const [generation, setGeneration] = useState(0);

  const baseDir = filePath ? filePath.replace(/[/\\][^/\\]*$/, "") : null;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
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
    }, REBUILD_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, baseDir, generation]);

  // The last blob outlives the effect above (its cleanup only cancels the
  // *pending* rebuild), so unmount has to revoke it explicitly.
  const urlRef = useRef<string | null>(null);
  urlRef.current = url;
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  const openInBrowser = async () => {
    if (!filePath) return;
    try {
      // The browser reads the file off disk — flush the editor's dirty
      // buffer first so it shows what the author is looking at, not the
      // last autosave.
      await useEditorStore.getState().saveNow();
      await openWithDefaultApp(filePath);
    } catch (e) {
      console.error("[HtmlPreview] open in browser failed:", e);
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
          onClick={() => void openInBrowser()}
          disabled={!filePath}
          title={t("editor.htmlPreview.openInBrowser")}
        >
          <ExternalLink size={11} />
          {t("editor.htmlPreview.openInBrowser")}
        </button>
      </div>
      {url && (
        <iframe
          className={styles.frame}
          src={url}
          sandbox="allow-scripts"
          title={t("editor.htmlPreview.title")}
        />
      )}
    </div>
  );
}
