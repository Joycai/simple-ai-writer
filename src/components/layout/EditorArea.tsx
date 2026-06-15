import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/projectStore";
import styles from "./EditorArea.module.css";

export function EditorArea() {
  const { t } = useTranslation();
  const { projectPath, activeFilePath } = useProjectStore();

  if (!projectPath || !activeFilePath) {
    return (
      <div className={styles.area}>
        <div className={styles.empty}>
          <div className={styles.logo}>✍️</div>
          <div className={styles.emptyTitle}>{t("app.name")}</div>
          <div className={styles.emptySubtitle}>{t("project.noProjectTitle")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.area}>
      {/* CodeMirror editor — Phase 2 */}
      <div style={{ padding: 40, color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)" }}>
        Editor for: {activeFilePath} — coming in Phase 2
      </div>
    </div>
  );
}
