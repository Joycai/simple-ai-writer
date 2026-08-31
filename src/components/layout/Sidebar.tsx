import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import { FileTree } from "./FileTree";
import { ProjectRow } from "./ProjectRow";
import { RecentProjects } from "./RecentProjects";
import { OutlinePanel } from "../editor/OutlinePanel";
import { panelFade, springPanel, useMotionPreset } from "../../lib/motion";
import styles from "./Sidebar.module.css";

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
  const projectPath = useProjectStore((s) => s.projectPath);

  const contentVariants = useMotionPreset(panelFade);

  const isTree = activeSideTab === "files";
  const isOutline = activeSideTab === "outline";

  return (
    <div className={`${styles.sidebar} ${sidebarCollapsed ? styles.collapsed : ""}`}>
      {/* 项目名 + 项目菜单 + 搜索 —— 设计稿 17 把原来的四层压到这一层加一条脚线，
          脚线（三个计数 / 剪贴板 / 定位当前文档）长在 FileTree 里，因为它说的三件
          事全是这棵树的事。 */}
      <ProjectRow />

      {/* 「文件」的节标题并进了 FileTree 的工具行（它们本来就是同一行的左右两半），
          其余标签页还需要自己的标题。 */}
      {projectPath && !isTree && (
        <div className={styles.headerLabel}>{t(`sidebar.${activeSideTab}`)}</div>
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
