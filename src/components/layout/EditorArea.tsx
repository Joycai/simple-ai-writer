import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore, type ViewMode } from "../../stores/editorStore";
import { CodeEditor } from "../editor/CodeEditor";
import { Preview } from "../editor/Preview";
import styles from "./EditorArea.module.css";

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: "editor", label: "编辑" },
  { id: "split", label: "分栏" },
  { id: "preview", label: "预览" },
];

export function EditorArea() {
  const { t } = useTranslation();
  const { projectPath, activeFilePath } = useProjectStore();
  const { content, filePath, isDirty, viewMode, loadFile, setContent, saveNow, setViewMode } =
    useEditorStore();

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

  const fileName = activeFilePath.split("/").pop() ?? t("editor.untitled");
  const showEditor = viewMode === "editor" || viewMode === "split";
  const showPreview = viewMode === "preview" || viewMode === "split";

  return (
    <div className={styles.area}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        {isDirty && <span className={styles.dirty} title="Unsaved changes" />}
        <span className={styles.fileName}>{fileName}</span>

        <div className={styles.viewToggle}>
          {VIEW_MODES.map((m) => (
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
            保存
          </button>
        )}
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
