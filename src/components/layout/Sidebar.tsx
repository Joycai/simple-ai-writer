import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Search as SearchIcon } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { useEditorStore } from "../../stores/editorStore";
import { FileTree } from "./FileTree";
import { RecentProjects } from "./RecentProjects";
import { OutlinePanel } from "../editor/OutlinePanel";
import { loreEntityCount } from "../../lib/lore";
import { MOD_K_SPACED } from "../../lib/platform";
import { panelFade, springPanel, useMotionPreset } from "../../lib/motion";
import styles from "./Sidebar.module.css";
import { baseName } from "../../lib/paths";

function basename(p: string | null): string | null {
  return p ? baseName(p) || null : null;
}

function countDocs(tree: { is_dir?: boolean; children?: any[]; name?: string }[]): number {
  let count = 0;
  for (const node of tree) {
    if (!node.is_dir && node.name?.endsWith(".md")) count++;
    if (node.children) count += countDocs(node.children);
  }
  return count;
}

/**
 * The project header's live counters, in their own component so their
 * subscriptions stay out of Sidebar itself: `wordCount` changes on every
 * keystroke, and a Sidebar that subscribed to it re-rendered the whole file
 * tree per character typed.
 */
function ProjectStats() {
  const { t } = useTranslation();
  const wordCount = useProjectStore((s) => s.wordCount);
  const fileTree = useProjectStore((s) => s.fileTree);
  const loreCount = useLoreStore((s) => loreEntityCount(s.index));
  const terms = useTerms();
  const docCount = useMemo(() => countDocs(fileTree as any), [fileTree]);
  return (
    <div className={styles.projectStats}>
      <span><strong>{wordCount.toLocaleString()}</strong>{t("statusBar.words")}</span>
      <span><strong>{docCount}</strong>{terms.docs}</span>
      <span><strong>{loreCount}</strong>{terms.entries}</span>
    </div>
  );
}

/**
 * Same idea for the outline tab: `headings` is a fresh array per keystroke
 * (editorStore.setContent re-extracts it), so only this subtree re-renders
 * with it — not the tabs, header, or the sibling file tree.
 */
function OutlineTab() {
  const headings = useEditorStore((s) => s.headings);
  return (
    <OutlinePanel
      headings={headings}
      onClickHeading={(h) => {
        const s = useEditorStore.getState();
        if (s.viewMode === "preview") s.setViewMode("split");
        s.scrollToLine?.(h.line);
      }}
    />
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const activeSideTab = useAppStore((s) => s.activeSideTab);
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);
  const projectPath = useProjectStore((s) => s.projectPath);
  const terms = useTerms();

  const projectName = basename(projectPath);
  const contentVariants = useMotionPreset(panelFade);

  const isTree = activeSideTab === "files";
  const isOutline = activeSideTab === "outline";

  return (
    <div className={`${styles.sidebar} ${sidebarCollapsed ? styles.collapsed : ""}`}>
      {/* Project header — only when project is open */}
      {projectPath && (
        <div className={styles.projectHeader}>
          <div className={styles.projectEyebrow}>{t("sidebar.project")}</div>
          <div className={styles.projectName}>{projectName ?? t("titleBar.noProject")}</div>
          <ProjectStats />
        </div>
      )}

      {/* Search box → opens command palette */}
      {projectPath && (
        <button
          className={styles.searchBox}
          onClick={() => setShowCommandPalette(true)}
        >
          <SearchIcon size={11} strokeWidth={1.6} color="var(--color-text-muted)" />
          <span className={styles.searchPlaceholder}>
            {t("sidebar.projectSearch", { entries: terms.entries })}
          </span>
          <span className={styles.searchKey}>{MOD_K_SPACED}</span>
        </button>
      )}

      {/* Section header label */}
      {projectPath && (
        <div className={styles.headerLabel}>
          {activeSideTab === "files" ? terms.filesHeader : t(`sidebar.${activeSideTab}`)}
        </div>
      )}

      {/* Enter-only（照 AiPanel.tsx:1384 的注释与先例）：标签切换是直接操纵，
          新面板应立即落位；keyed motion.div 仍会重置子树。 */}
      <motion.div
        key={projectPath ? activeSideTab : "empty"}
        className={projectPath && isTree ? styles.contentFlush : styles.content}
        variants={contentVariants}
        initial="initial"
        animate="animate"
        transition={springPanel}
      >
        {!projectPath ? (
          <RecentProjects />
        ) : (
          <>
            {isTree && <FileTree />}
            {isOutline && <OutlineTab />}
            {activeSideTab === "search" && (
              <div className={styles.emptyState}>
                <div>{t("sidebar.searchComingSoon")}</div>
              </div>
            )}
          </>
        )}
      </motion.div>
    </div>
  );
}
