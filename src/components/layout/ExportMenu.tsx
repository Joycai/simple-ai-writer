/**
 * The export entry point for the open document.
 *
 * Markdown to the clipboard, a self-contained HTML file, or the system print
 * dialog for PDF. Each carries the document's own folder as the base for its
 * relative image links — an exported file has no relation to the project, so
 * without it every `assets/…` picture resolves to nothing (see lib/fs/export).
 *
 * There is no toast in this app, so the button reports its own outcome for a
 * moment: copying to the clipboard is otherwise completely silent, and an
 * author who sees nothing happen tries again.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import { exportHtml, exportMarkdown, exportPdf } from "../../lib/fs/export";
import { useEditorStore } from "../../stores/editorStore";
import { useProjectStore } from "../../stores/projectStore";
import styles from "./TitleBar.module.css";

/** How long the button shows what just happened before returning to normal. */
const FEEDBACK_MS = 2000;

/** Directory part of a path, which is what relative image links resolve against. */
function dirOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const cut = norm.lastIndexOf("/");
  return cut === -1 ? "" : norm.slice(0, cut);
}

export function ExportMenu() {
  const { t } = useTranslation();
  const activeFilePath = useProjectStore((s) => s.activeFilePath);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!activeFilePath) return null;

  const flash = (message: string) => {
    setStatus(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), FEEDBACK_MS);
  };

  /**
   * Read the document at click time, not at render: the editor's buffer holds
   * unsaved edits, and exporting the last-saved version of what is visibly on
   * screen would be a quiet lie.
   */
  const current = () => {
    const { content } = useEditorStore.getState();
    const title = (activeFilePath.split(/[\\/]/).pop() ?? "document").replace(/\.md$/i, "");
    return { content, title, baseDir: dirOf(activeFilePath) };
  };

  const run = async (kind: "markdown" | "html" | "pdf") => {
    const { content, title, baseDir } = current();
    try {
      if (kind === "markdown") {
        await exportMarkdown(content);
        flash(t("editor.exportCopied"));
      } else if (kind === "html") {
        const saved = await exportHtml(content, title, baseDir);
        if (saved) flash(t("editor.exportSaved"));
      } else {
        await exportPdf(content, title, baseDir);
      }
    } catch (e) {
      flash(t("editor.exportFailed", { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const items: ContextMenuEntry[] = [
    { kind: "item", label: t("editor.exportMarkdown"), action: () => void run("markdown") },
    { kind: "item", label: t("editor.exportHtml"), action: () => void run("html") },
    { kind: "item", label: t("editor.exportPdf"), action: () => void run("pdf") },
  ];

  return (
    <>
      <button
        className={styles.ctrl}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.left, y: r.bottom + 4 });
        }}
        title={t("editor.export")}
      >
        {status ? <Check size={12} /> : null}
        {status ?? t("editor.export")}
        {!status && <ChevronDown size={9} strokeWidth={2} className={styles.ctrlChevron} />}
      </button>
      {menuAt && (
        <ContextMenu x={menuAt.x} y={menuAt.y} items={items} onClose={() => setMenuAt(null)} />
      )}
    </>
  );
}
