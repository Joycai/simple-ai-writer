import { useEffect, useRef } from "react";
import { renderMarkdown } from "../../lib/fs/markdown";
import { imageToDataUrl } from "../../lib/fs/images";
import { resolveRelativePath } from "../../lib/paths";
import styles from "./Preview.module.css";

interface Props {
  source: string;
  /** Directory of the source file, used to resolve relative image links. */
  basePath?: string | null;
}

export function Preview({ source, basePath }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = renderMarkdown(source);

    // Resolve local image links into inline data URLs. The webview can't load
    // file paths directly (CSP + the base URL isn't the document's folder), so
    // for every relative/local <img> we read the referenced file relative to the
    // markdown file and inline it — same approach ImagePreview uses.
    if (basePath) {
      ref.current.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
        const raw = img.getAttribute("src") ?? "";
        if (!raw || /^(https?:|data:|blob:|ai-writer-asset:)/i.test(raw)) return;
        let rel = raw;
        try { rel = decodeURI(raw); } catch { /* keep raw on malformed escape */ }
        const abs = resolveRelativePath(basePath, rel);
        imageToDataUrl(abs)
          .then(({ dataUrl }) => { img.src = dataUrl; })
          .catch(() => { img.setAttribute("data-broken", "true"); });
      });
    }

    // Lazy-render Mermaid blocks
    const mermaidBlocks = ref.current.querySelectorAll<HTMLElement>("code.language-mermaid");
    if (mermaidBlocks.length === 0) return;

    import("mermaid").then(({ default: mermaid }) => {
      // Follow the app theme so diagrams aren't dark-on-white in light mode.
      const isLight = document.documentElement.getAttribute("data-theme") === "light";
      mermaid.initialize({ startOnLoad: false, theme: isLight ? "default" : "dark", securityLevel: "loose" });
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
  }, [source]);

  return <div ref={ref} className={styles.preview} data-ai-selection />;
}
