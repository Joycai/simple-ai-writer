/**
 * 侧栏顶端那一行：项目名 + 它自己的菜单 + 搜索（设计稿 17 §1f / §2a）。
 *
 * 两件事在这里被合并掉了：原来的眉标「PROJECT」和那个**假搜索框**。搜索框点开的
 * 是命令面板 —— 一个全屏浮层，有自己的输入框、结果列表和作用域；面板里那个带边框
 * 的输入框承诺的却是「在这里就地筛选这棵树」，两者不是一回事。所以它变成一枚放大
 * 镜，宽档时旁边补一个 ⌘K 字样。
 *
 * 原工具栏最左边的三个图标（切换项目 / 新窗口 / 关闭项目）也搬到了这里：它们作用
 * 于**项目**，不是对树的操作 —— 分类问题，不是空间问题。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, ChevronDown, Copy, FolderInput, FolderOpen, LogOut, Search } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { openInNewWindow } from "../../lib/instance";
import { baseName } from "../../lib/paths";
import { comboLabel, matchesCombo } from "../../lib/shortcuts";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import styles from "./Sidebar.module.css";

const SWITCH_COMBO = { mod: true, shift: true, key: "o" } as const;
const CLOSE_COMBO = { mod: true, shift: true, key: "w" } as const;

export function ProjectRow() {
  const { t } = useTranslation();
  const projectPath = useProjectStore((s) => s.projectPath);
  const openProject = useProjectStore((s) => s.openProject);
  const closeProject = useProjectStore((s) => s.closeProject);
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // 这两条挂在侧栏自己身上而不是全局派发表里：它们作用于「打开着的项目」，而这一行
  // 正是那个项目在界面上的样子 —— 没有项目时它根本不渲染，绑定也就跟着不在。
  useEffect(() => {
    if (!projectPath) return;
    const onKey = (e: KeyboardEvent) => {
      if (matchesCombo(e, SWITCH_COMBO)) {
        e.preventDefault();
        void openProject();
      } else if (matchesCombo(e, CLOSE_COMBO)) {
        e.preventDefault();
        void closeProject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectPath, openProject, closeProject]);

  if (!projectPath) return null;
  const name = baseName(projectPath) || projectPath;

  const items = (): ContextMenuEntry[] => [
    { kind: "item", icon: <FolderOpen size={13} />, label: t("project.revealProject"),
      action: () => { revealItemInDir(projectPath).catch(() => { /* best-effort */ }); } },
    { kind: "item", icon: <Copy size={13} />, label: t("project.copyPath"),
      action: () => { void navigator.clipboard?.writeText(projectPath).catch(() => { /* best-effort */ }); } },
    { kind: "divider" },
    { kind: "item", icon: <FolderInput size={13} />, label: t("project.switchProject"),
      shortcut: comboLabel(SWITCH_COMBO), action: () => void openProject() },
    // 新窗口刻意不带快捷键：设计稿把 ⇧⌘N 同时给了它和「新建分组」，而树里那个更常
    // 用，也与访达一致（⇧⌘N ＝ 新建文件夹）。
    { kind: "item", icon: <AppWindow size={13} />, label: t("project.newWindow"),
      action: () => void openInNewWindow().catch((e) => console.warn("[instance]", e)) },
    { kind: "divider" },
    { kind: "item", icon: <LogOut size={13} />, label: t("project.closeProject"),
      shortcut: comboLabel(CLOSE_COMBO), action: () => void closeProject() },
  ];

  return (
    <>
      <div className={styles.projectRow} ref={rowRef}>
        <button
          className={styles.projectName}
          onClick={() => {
            const r = rowRef.current?.getBoundingClientRect();
            setMenuAt({ x: (r?.left ?? 0) + 8, y: (r?.bottom ?? 0) + 2 });
          }}
          title={projectPath}
        >
          <span className={styles.projectNameText}>{name}</span>
          <ChevronDown size={11} strokeWidth={2} className={styles.projectCaret} />
        </button>
        <span className={styles.projectSpacer} />
        <button
          className={styles.projectSearch}
          title={t("sidebar.searchTooltip", { key: comboLabel({ mod: true, key: "k" }) })}
          onClick={() => setShowCommandPalette(true)}
        >
          <Search size={14} strokeWidth={1.7} />
        </button>
        <span className={styles.searchKey}>{comboLabel({ mod: true, key: "k" })}</span>
      </div>
      {menuAt && (
        <ContextMenu x={menuAt.x} y={menuAt.y} items={items()} onClose={() => setMenuAt(null)} />
      )}
    </>
  );
}
