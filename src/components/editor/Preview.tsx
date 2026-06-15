import { useEffect, useRef } from "react";
import { renderMarkdown } from "../../lib/markdown";
import styles from "./Preview.module.css";

interface Props {
  source: string;
}

export function Preview({ source }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = renderMarkdown(source);

    // Lazy-render Mermaid blocks
    const mermaidBlocks = ref.current.querySelectorAll<HTMLElement>("code.language-mermaid");
    if (mermaidBlocks.length === 0) return;

    import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
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

  return <div ref={ref} className={styles.preview} />;
}
