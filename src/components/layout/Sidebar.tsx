import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { FileTree } from "./FileTree";
import { LorePanel } from "../lore/LorePanel";
import styles from "./Sidebar.module.css";

const TAB_LABELS: Record<string, string> = {
  files: "sidebar.files",
  lore: "sidebar.lore",
  search: "sidebar.search",
};

export function Sidebar() {
  const { t } = useTranslation();
  const { sidebarCollapsed, activeSideTab } = useAppStore();
  const { projectPath, openProject, isLoading } = useProjectStore();

  const isFlush = activeSideTab === "files" || activeSideTab === "lore";

  return (
    <div className={`${styles.sidebar} ${sidebarCollapsed ? styles.collapsed : ""}`}>
      {/* Files and Lore panels have their own toolbars */}
      {!isFlush && (
        <div className={styles.header}>{t(TAB_LABELS[activeSideTab])}</div>
      )}

      <div className={isFlush ? styles.contentFlush : styles.content}>
        {!projectPath ? (
          <div className={styles.emptyState}>
            <div>{t("project.noProjectTitle")}</div>
            <div style={{ fontSize: "var(--font-size-xs)", marginTop: 4 }}>
              {t("project.noProjectDesc")}
            </div>
            <button
              className={styles.openBtn}
              onClick={openProject}
              disabled={isLoading}
            >
              {isLoading ? "…" : t("project.openFolder")}
            </button>
          </div>
        ) : (
          <>
            {activeSideTab === "files" && <FileTree />}
            {activeSideTab === "lore" && <LorePanel />}
            {activeSideTab === "search" && (
              <div style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-xs)", padding: "var(--space-3)" }}>
                Search — coming soon
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
