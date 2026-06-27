import { useTranslation } from "react-i18next";
import { Search as SearchIcon } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { useEditorStore } from "../../stores/editorStore";
import { FileTree } from "./FileTree";
import { LorePanel } from "../lore/LorePanel";
import { OutlinePanel } from "../editor/OutlinePanel";
import { MOD_K_SPACED } from "../../lib/platform";
import styles from "./Sidebar.module.css";

function basename(p: string | null): string | null {
  if (!p) return null;
  const norm = p.replace(/\\/g, "/");
  return norm.split("/").filter(Boolean).pop() ?? null;
}

function countChapters(tree: { is_dir?: boolean; children?: any[]; name?: string }[]): number {
  let count = 0;
  for (const node of tree) {
    if (!node.is_dir && node.name?.endsWith(".md")) count++;
    if (node.children) count += countChapters(node.children);
  }
  return count;
}

export function Sidebar() {
  const { t } = useTranslation();
  const { sidebarCollapsed, activeSideTab, setShowCommandPalette } = useAppStore();
  const { projectPath, openProject, isLoading, fileTree, wordCount } = useProjectStore();
  const loreCount = useLoreStore((s) => Object.keys(s.index).length);
  const { headings } = useEditorStore();

  const projectName = basename(projectPath);
  const chapterCount = countChapters(fileTree as any);

  const isTree = activeSideTab === "files";
  const isOutline = activeSideTab === "outline";

  return (
    <div className={`${styles.sidebar} ${sidebarCollapsed ? styles.collapsed : ""}`}>
      {/* Project header — only when project is open */}
      {projectPath && (
        <div className={styles.projectHeader}>
          <div className={styles.projectEyebrow}>{t("sidebar.project")}</div>
          <div className={styles.projectName}>{projectName ?? t("titleBar.noProject")}</div>
          <div className={styles.projectStats}>
            <span><strong>{wordCount.toLocaleString()}</strong>{t("statusBar.words")}</span>
            <span><strong>{chapterCount}</strong>章</span>
            <span><strong>{loreCount}</strong>设定</span>
          </div>
        </div>
      )}

      {/* Search box → opens command palette */}
      {projectPath && (
        <button
          className={styles.searchBox}
          onClick={() => setShowCommandPalette(true)}
          style={{ all: "unset", margin: "16px 22px 0", display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", background: "var(--color-bg-base)", border: "1px solid var(--color-border)", cursor: "pointer" }}
        >
          <SearchIcon size={11} strokeWidth={1.6} color="var(--color-text-muted)" />
          <span className={styles.searchPlaceholder}>{t("sidebar.projectSearch")}</span>
          <span className={styles.searchKey}>{MOD_K_SPACED}</span>
        </button>
      )}

      {/* Section header label */}
      {projectPath && (
        <div className={styles.headerLabel}>
          {t(`sidebar.${activeSideTab === "files" ? "manuscript" : activeSideTab}`)}
        </div>
      )}

      <div className={isTree ? styles.contentFlush : styles.content}>
        {!projectPath ? (
          <div className={styles.emptyState}>
            <div>{t("project.noProjectTitle")}</div>
            <div>{t("project.noProjectDesc")}</div>
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
            {isTree && <FileTree />}
            {activeSideTab === "lore" && <LorePanel />}
            {isOutline && (
              <OutlinePanel
                headings={headings}
                onClickHeading={(h) => {
                  const s = useEditorStore.getState();
                  if (s.viewMode === "preview") s.setViewMode("split");
                  s.scrollToLine?.(h.line);
                }}
              />
            )}
            {activeSideTab === "search" && (
              <div className={styles.emptyState}>
                <div>{t("sidebar.searchComingSoon")}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
