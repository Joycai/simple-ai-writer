import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore, type ViewMode } from "../../stores/editorStore";
import { CodeEditor } from "../editor/CodeEditor";
import { Preview } from "../editor/Preview";
import { exportMarkdown, exportHtml, exportPdf } from "../../lib/export";
import styles from "./EditorArea.module.css";

const VIEW_MODES_CONFIG: { id: ViewMode; labelKey: string }[] = [
  { id: "editor", labelKey: "editor.viewMode.editor" },
  { id: "split", labelKey: "editor.viewMode.split" },
  { id: "preview", labelKey: "editor.viewMode.preview" },
];

export function EditorArea() {
  const { t } = useTranslation();
  const { projectPath, activeFilePath } = useProjectStore();
  const { content, filePath, isDirty, viewMode, loadFile, setContent, saveNow, setViewMode } =
    useEditorStore();

  const viewModes = VIEW_MODES_CONFIG.map((m) => ({
    ...m,
    label: t(m.labelKey),
  }));

  // Load file when active path changes
  useEffect(() => {
    if (activeFilePath && activeFilePath !== filePath) {
      loadFile(activeFilePath);
    }
  }, [activeFilePath, filePath, loadFile]);

  // Ctrl/Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveNow();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveNow]);

  if (!projectPath || !activeFilePath) {
    return (
      <div className={styles.area}>
        <div className={styles.empty}>
          <div className={styles.logo}>✍️</div>
          <div className={styles.emptyTitle}>{t("app.name")}</div>
          <div style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
            {t("project.noProjectTitle")}
          </div>
        </div>
      </div>
    );
  }

  const [showExportMenu, setShowExportMenu] = useState(false);

  const fileName = activeFilePath.split("/").pop() ?? t("editor.untitled");
  const title = fileName.replace(/\.md$/i, "");
  const showEditor = viewMode === "editor" || viewMode === "split";
  const showPreview = viewMode === "preview" || viewMode === "split";

  const handleExportMd = async () => {
    setShowExportMenu(false);
    await exportMarkdown(content);
  };

  const handleExportHtml = async () => {
    setShowExportMenu(false);
    const savePath = await save({
      defaultPath: `${title}.html`,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (savePath) await exportHtml(content, title, savePath);
  };

  const handleExportPdf = () => {
    setShowExportMenu(false);
    exportPdf(content, title);
  };

  return (
    <div className={styles.area}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        {isDirty && <span className={styles.dirty} title="Unsaved changes" />}
        <span className={styles.fileName}>{fileName}</span>

        <div className={styles.viewToggle}>
          {viewModes.map((m) => (
            <button
              key={m.id}
              className={`${styles.viewBtn} ${viewMode === m.id ? styles.active : ""}`}
              onClick={() => setViewMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {isDirty && (
          <button className={styles.saveBtn} onClick={saveNow}>
            {t("editor.save")}
          </button>
        )}

        <div style={{ position: "relative" }}>
          <button className={styles.saveBtn} onClick={() => setShowExportMenu((v) => !v)}>
            {t("editor.export")} ▾
          </button>
          {showExportMenu && (
            <div className={styles.exportMenu} onMouseLeave={() => setShowExportMenu(false)}>
              <button className={styles.exportItem} onClick={handleExportMd}>
                {t("editor.exportMarkdown")}
              </button>
              <button className={styles.exportItem} onClick={handleExportHtml}>
                {t("editor.exportHtml")}
              </button>
              <button className={styles.exportItem} onClick={handleExportPdf}>
                {t("editor.exportPdf")}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Editor + Preview panes */}
      <div className={styles.panes}>
        {showEditor && (
          <div className={styles.editorPane}>
            <CodeEditor value={content} onChange={setContent} />
          </div>
        )}
        {showPreview && (
          <div className={styles.previewPane}>
            <Preview source={content} />
          </div>
        )}
      </div>
    </div>
  );
}
