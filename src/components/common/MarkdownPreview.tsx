import { useEffect, useRef } from "react";
import { renderMarkdown } from "../../lib/fs/markdown";
import { imageToDataUrl } from "../../lib/fs/images";
import { resolveRelativePath } from "../../lib/paths";
import { annotateCitations } from "../../lib/lore/citations";
import { useLoreStore } from "../../stores/loreStore";
import { MD_BODY_CLASS } from "../../lib/theme/markdownThemes";

interface Props {
  source: string;
  /** Directory of the source file, used to resolve relative image links. */
  basePath?: string | null;
  className?: string;
}

/**
 * Rendered-markdown block for compact surfaces (modal fields, cards).
 *
 * Typography comes from the active markdown theme via `.md-body` — the same
 * look the editor preview and exported documents use. Callers scale it for a
 * small container by setting `--md-size` in their own class.
 *
 * The editor pane keeps its own `Preview`: it adds mermaid rendering and the
 * full-page frame. Shared here: relative-image inlining (the webview can't load
 * file paths, so local `<img>` sources are read off disk into data URLs) and
 * lore-citation annotation.
 */
export function MarkdownPreview({ source, basePath, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = renderMarkdown(source);
    annotateCitations(el, useLoreStore.getState().index);
    if (!basePath) return;

    let cancelled = false;
    el.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const raw = img.getAttribute("src") ?? "";
      if (!raw || /^(https?:|data:|blob:|ai-writer-asset:)/i.test(raw)) return;
      let rel = raw;
      try { rel = decodeURI(raw); } catch { /* keep raw on malformed escape */ }
      imageToDataUrl(resolveRelativePath(basePath, rel))
        .then(({ dataUrl }) => { if (!cancelled) img.src = dataUrl; })
        .catch(() => { img.setAttribute("data-broken", "true"); });
    });
    return () => { cancelled = true; };
  }, [source, basePath]);

  return <div ref={ref} className={className ? `${MD_BODY_CLASS} ${className}` : MD_BODY_CLASS} />;
}
