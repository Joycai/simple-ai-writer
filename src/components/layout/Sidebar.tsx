import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import styles from "./Sidebar.module.css";

const TAB_LABELS: Record<string, string> = {
  files: "sidebar.files",
  lore: "sidebar.lore",
  search: "sidebar.search",
};

export function Sidebar() {
  const { t } = useTranslation();
  const { sidebarCollapsed, activeSideTab } = useAppStore();
  const { projectPath } = useProjectStore();

  return (
    <div className={`${styles.sidebar} ${sidebarCollapsed ? styles.collapsed : ""}`}>
      <div className={styles.header}>{t(TAB_LABELS[activeSideTab])}</div>
      <div className={styles.content}>
        {!projectPath ? (
          <div className={styles.emptyState}>
            <div>{t("project.noProjectTitle")}</div>
            <div style={{ fontSize: "var(--font-size-xs)", marginTop: 4 }}>
              {t("project.noProjectDesc")}
            </div>
            <button className={styles.openBtn}>{t("project.openFolder")}</button>
          </div>
        ) : (
          <div style={{ color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)" }}>
            {activeSideTab === "files" && <span>File tree — coming in Phase 1</span>}
            {activeSideTab === "lore" && <span>Lore library — coming in Phase 3</span>}
            {activeSideTab === "search" && <span>Search — coming soon</span>}
          </div>
        )}
      </div>
    </div>
  );
}
