import { useEffect, useRef } from "react";
import { renderMarkdown } from "../../lib/fs/markdown";
import { imageToDataUrl } from "../../lib/fs/images";
import { resolveRelativePath } from "../../lib/paths";
import { annotateCitations } from "../../lib/lore/citations";
import { useLoreStore } from "../../stores/loreStore";
import { MD_BODY_CLASS } from "../../lib/theme/markdownThemes";
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
  }, [source]);

  // data-preview-scroller marks the element that actually scrolls (the root is
  // the one carrying `overflow-y: auto`). EditorArea's split-view sync finds it
  // by this attribute rather than by firstElementChild, so adding a sibling or
  // a wrapper in here can't silently break scroll linking.
  //
  // The inner element holds the measure (max-width + auto margins) and the
  // markdown theme: themes set element margins outright, so centring each
  // rendered child individually would be a specificity fight the theme wins.
  return (
    <div className={styles.preview} data-preview-scroller>
      <div ref={ref} className={`${styles.page} ${MD_BODY_CLASS}`} data-ai-selection />
    </div>
  );
}
