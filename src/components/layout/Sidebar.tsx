import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import { FileTree } from "./FileTree";
import { ProjectRow } from "./ProjectRow";
import { RecentProjects } from "./RecentProjects";
import { OutlinePanel } from "../editor/OutlinePanel";
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

  const isTree = activeSideTab === "files";
  const isOutline = activeSideTab === "outline";

  return (
    <div className={`${styles.sidebar} ${sidebarCollapsed ? styles.collapsed : ""}`}>
      {/* 项目名 + 项目菜单 + 搜索 —— 设计稿 01b 把原来的四层压到这一层加一条脚线，
          脚线（三个计数 / 剪贴板 / 定位当前文档）长在 FileTree 里，因为它说的三件
          事全是这棵树的事。 */}
      <ProjectRow />

      {/* 「文件」的节标题并进了 FileTree 的工具行（它们本来就是同一行的左右两半），
          其余标签页还需要自己的标题。 */}
      {projectPath && !isTree && (
        <div className={styles.headerLabel}>{t(`sidebar.${activeSideTab}`)}</div>
      )}

      {/* 标签切换不做入场（方案 044）：⌘1/⌘2（lib/shortcuts.ts SCREEN_COMBOS）与
          IconRail 是同一个动作，100+/天，AUDIT §1「永不动画」——与 Sidebar.module.css
          顶部注释给折叠定的是同一档。方案 004 的 enter-only 入场定于 ⌘1‥⌘5 出现之前。
          key 保留：换标签仍重置子树。 */}
      <div
        key={projectPath ? activeSideTab : "empty"}
        className={projectPath && isTree ? styles.contentFlush : styles.content}
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
      </div>
    </div>
  );
}
