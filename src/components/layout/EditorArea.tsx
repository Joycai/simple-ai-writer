import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import { CodeEditor } from "../editor/CodeEditor";
import { Preview } from "../editor/Preview";
import { EditorBottomStrip } from "./EditorBottomStrip";
import { MOD_KEY } from "../../lib/platform";
import styles from "./EditorArea.module.css";

export function EditorArea() {
  const { t } = useTranslation();
  const { projectPath, activeFilePath } = useProjectStore();
  const { content, filePath, viewMode, loadFile, setContent, saveNow } = useEditorStore();
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);

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
          <div className={styles.emptyInner}>
            <div className={styles.emptyEyebrow}>{t("empty.chapterEyebrow")}</div>
            <h1 className={styles.emptyTitle}>{t("empty.firstLine")}</h1>
            <div className={styles.emptyOrnament}>{t("empty.ornament")}</div>
            <p className={styles.emptyHint}>{t("empty.hint1")}</p>
            <p className={styles.emptyHint}>{t("empty.hint2")}</p>

            <div className={styles.emptyCta}>
              <span className={styles.emptyCtaText}>{t("empty.dontKnow")}</span>
              <button
                className={styles.emptyCtaBtn}
                onClick={() => setShowCommandPalette(true)}
              >
                <Sparkles size={11} />
                {t("empty.letAi", { mod: MOD_KEY })}
              </button>
            </div>

            <div className={styles.tipGrid}>
              <div className={styles.tipCard}>
                <div className={styles.tipLabel}>{t("empty.tipCmdkLabel", { mod: MOD_KEY })}</div>
                <div className={styles.tipText}>{t("empty.tipCmdk")}</div>
              </div>
              <div className={styles.tipCard}>
                <div className={styles.tipLabel}>[[ 名 ]]</div>
                <div className={styles.tipText}>{t("empty.tipBrackets")}</div>
              </div>
              <div className={styles.tipCard}>
                <div className={styles.tipLabel}>{t("empty.tipSaveLabel", { mod: MOD_KEY })}</div>
                <div className={styles.tipText}>{t("empty.tipSave")}</div>
              </div>
            </div>
          </div>
        </div>
        <EditorBottomStrip />
      </div>
    );
  }

  const showEditor = viewMode === "editor" || viewMode === "split";
  const showPreview = viewMode === "preview" || viewMode === "split";

  return (
    <div className={styles.area}>
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
      <EditorBottomStrip />
    </div>
  );
}
