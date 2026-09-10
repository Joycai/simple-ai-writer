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
import { Check, ChevronDown, Download } from "lucide-react";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import { exportHtml, exportMarkdown, exportPdf, isExportableDocument } from "../../lib/fs/export";
import { getWritingFocus, useWritingFocus } from "../../stores/editorStore";
import styles from "./TitleBar.module.css";
import { baseName, dirName } from "../../lib/paths";

/** How long the button shows what just happened before returning to normal. */
const FEEDBACK_MS = 2000;

/** Directory part of a path, which is what relative image links resolve against. */
const dirOf = dirName;

export function ExportMenu() {
  const { t } = useTranslation();
  const focus = useWritingFocus();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // The gate is the writing focus, not `activeFilePath`. Those two name
  // different files whenever the author opens something the editor does not
  // load as text (an image, a .docx), and this menu exports the *editor's*
  // buffer — so keying on the opened path meant "导出" was in reach for a
  // picture and wrote out the previously open chapter under the picture's
  // name. `isExportableDocument` then drops the files these three exports
  // would render wrong (an .html deliverable through the markdown renderer).
  if (!focus.settled || !focus.filePath || !isExportableDocument(focus.filePath)) return null;

  const flash = (message: string) => {
    setStatus(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), FEEDBACK_MS);
  };

  /**
   * Read the document at click time, not at render: the editor's buffer holds
   * unsaved edits, and exporting the last-saved version of what is visibly on
   * screen would be a quiet lie. One focus read gives text and path together,
   * so they can never name two different documents.
   */
  const current = () => {
    const { filePath, text, settled } = getWritingFocus();
    if (!settled || !filePath) return null;
    const title = (baseName(filePath) || "document").replace(/\.md$/i, "");
    return { content: text, title, baseDir: dirOf(filePath) };
  };

  const run = async (kind: "markdown" | "html" | "pdf") => {
    // Only reachable in the instant between the author's click and a file
    // switch settling; nothing to export and nothing worth saying about it.
    const doc = current();
    if (!doc) return;
    const { content, title, baseDir } = doc;
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
    // 一个 .txt 走的是和 .md 完全相同的三条路（预览、导出都按 Markdown 渲染）。
    // 与其为它单立一类，不如在菜单第一行把这件事说出来（设计稿 01e 屏 1d-1）。
    ...(/\.txt$/i.test(focus.filePath)
      ? [{ kind: "item" as const, label: t("editor.exportTxtHint"), disabled: true, action: () => {} }]
      : []),
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
        {status ? (
          <span className={styles.ctrlStatus}>
            <Check size={12} />
            {status}
          </span>
        ) : (
          <>
            {/* 窄档收成一枚图标（表 A ⑤）；两种成色都渲染出来、由容器查询藏掉
                一种——查询能换布局，换不了词。 */}
            <span className={styles.notNarrow}>{t("editor.export")}</span>
            <ChevronDown size={9} strokeWidth={2} className={`${styles.ctrlChevron} ${styles.notNarrow}`} />
            <Download size={13} strokeWidth={1.8} className={styles.narrowOnly} />
          </>
        )}
      </button>
      {menuAt && (
        <ContextMenu x={menuAt.x} y={menuAt.y} items={items} onClose={() => setMenuAt(null)} />
      )}
    </>
  );
}
