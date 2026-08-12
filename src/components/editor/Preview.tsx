import { useEffect, useRef } from "react";
import { renderMarkdown } from "../../lib/fs/markdown";
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

export function Preview({ source, basePath }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  /**
   * Decoded pictures, by absolute path — the value once it has landed, or the
   * in-flight read that will produce it.
   *
   * This effect re-runs on **every keystroke** in split view (the whole DOM is
   * rebuilt from `source`), so without a cache each character retyped meant
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
  }, [source, basePath]);

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
