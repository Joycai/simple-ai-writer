/**
 * 文件面板 · 未打开项目时的那块（设计稿 15「固定最近项目 Pin Recents」）。
 *
 * 三个决定连成一条线，改这个文件之前先读懂它们：
 *
 * 1. **固定＝换节住**，不是行上的一枚标记。一个项目要么在「已固定」，要么在
 *    「最近打开」，不会同时出现 —— 于是「恒在上方、不下沉、不被 10 条淘汰」
 *    全是这个模型的自然结果，而不是三条要各自维护的规则（数据侧同理：
 *    `lib/recentProjects.splitProjects`）。
 * 2. **「清空最近」长在它清的那一节的标题行里**。作用域由位置说清，按钮不用背
 *    长文案；「全部都被固定」那个态因此根本不存在 —— 空的小节整节不渲染，按钮
 *    跟着一起走，没有禁用态要设计。
 * 3. **一行只留一个有状态的图标**。240px 塞不下第三个，所以不塞：另两个纯动作
 *    下沉到右键菜单（知识库墙和文件树已经在教作者按右键），行内只留固定 ——
 *    它是唯一在静息时也要可读的东西。
 *
 * 密度三档走**容器查询**而不是读 `sidebarWidth`：拖动过程中栏宽只活在 CSS 变量
 * 里，读 store 的断点会在松手前一直是旧的。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, Copy, ExternalLink, Folder, Pin, PinOff, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { openInNewWindow } from "../../lib/instance";
import { isProjectPinned, openedAtKind, splitProjects } from "../../lib/recentProjects";
import { baseName } from "../../lib/paths";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import styles from "./RecentProjects.module.css";

/** The `--ease-out` token, as Motion easing (same curve, two languages). */
const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

/** How long the undo stays offered after a 清空. */
const UNDO_MS = 5000;

/** Above this many pinned projects the section earns a collapse toggle. */
const COLLAPSE_FROM = 6;

type PendingClear = { previous: string[]; cleared: number; kept: number };

export function RecentProjects() {
  const { t, i18n } = useTranslation();
  const recentProjects = useAppStore((s) => s.recentProjects);
  const pinnedProjects = useAppStore((s) => s.pinnedProjects);
  const projectOpenedAt = useAppStore((s) => s.projectOpenedAt);
  const pinHintDone = useAppStore((s) => s.pinHintDone);
  const removeRecentProject = useAppStore((s) => s.removeRecentProject);
  const pinProject = useAppStore((s) => s.pinProject);
  const unpinProject = useAppStore((s) => s.unpinProject);
  const openProject = useProjectStore((s) => s.openProject);
  const isLoading = useProjectStore((s) => s.isLoading);

  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [pending, setPending] = useState<PendingClear | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const undoTimer = useRef<number | undefined>(undefined);
  const reduced = useReducedMotion();

  const { pinned, recent } = useMemo(
    () => splitProjects(recentProjects, pinnedProjects),
    [recentProjects, pinnedProjects],
  );

  /**
   * Close the undo window: the clear becomes final, and *that* is when the
   * dropped projects' own preferences are collected. Doing it inside the clear
   * would make an undo five seconds later hand back a project without its
   * pinned entries or its 取材范围.
   */
  const commitClear = useCallback(() => {
    window.clearTimeout(undoTimer.current);
    undoTimer.current = undefined;
    setPending(null);
    useAppStore.getState().collectUnlistedProjectPrefs();
  }, []);

  // Leaving this panel (a project was opened) closes the window the same way.
  useEffect(() => () => {
    if (undoTimer.current === undefined) return;
    window.clearTimeout(undoTimer.current);
    useAppStore.getState().collectUnlistedProjectPrefs();
  }, []);

  // The store call sits outside the state updater on purpose: React invokes an
  // updater more than once (StrictMode, a discarded concurrent render), and a
  // write to an external store is not something to run twice.
  const undoClear = useCallback(() => {
    if (!pending) return;
    window.clearTimeout(undoTimer.current);
    undoTimer.current = undefined;
    useAppStore.getState().restoreRecentProjects(pending.previous);
    setPending(null);
  }, [pending]);

  const onClear = () => {
    const previous = useAppStore.getState().clearRecentProjects();
    if (previous.length === 0) return;
    const kept = useAppStore.getState().recentProjects.length;
    setPending({ previous, cleared: previous.length - kept, kept });
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(commitClear, UNDO_MS);
  };

  /**
   * Any *other* edit to the list closes the undo window first.
   *
   * The undo replays the pre-clear list verbatim, so a removal or an unpin
   * made while the bar is up would be silently reverted by it — 「撤销」 would
   * hand back the very project the author had just deleted. Ending the window
   * is the honest resolution: the bar is a five-second offer, and touching the
   * list is an answer to it.
   */
  const afterUndoWindow = (edit: () => void) => {
    if (pending) commitClear();
    edit();
  };

  // ⌘Z / Ctrl+Z while the bar is up — the same undo, from the keyboard. No
  // editor is mounted in this state, so nothing else wants the chord.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoClear();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, undoClear]);

  const togglePin = (path: string) => afterUndoWindow(() => {
    if (isProjectPinned(pinnedProjects, path)) unpinProject(path);
    else pinProject(path);
  });

  /** Last-opened stamp, printed only by the widest layout (CSS decides). */
  const openedLabel = (path: string): string => {
    const ts = projectOpenedAt[path];
    if (!ts) return "";
    const d = new Date(ts);
    const kind = openedAtKind(ts, Date.now());
    if (kind === "older") {
      return new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }).format(d);
    }
    const time = new Intl.DateTimeFormat(i18n.language, {
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
    return t(kind === "today" ? "project.openedToday" : "project.openedYesterday", { time });
  };

  const menuItems = (path: string): ContextMenuEntry[] => {
    const isPinned = isProjectPinned(pinnedProjects, path);
    return [
      {
        kind: "item",
        icon: isPinned ? <PinOff size={13} /> : <Pin size={13} />,
        label: t(isPinned ? "project.unpin" : "project.pin"),
        action: () => togglePin(path),
      },
      // The multi-open path — a sibling instance straight onto this project.
      {
        kind: "item",
        icon: <ExternalLink size={13} />,
        label: t("project.openInNewWindow"),
        action: () => void openInNewWindow(path).catch((e) => console.warn("[instance]", e)),
      },
      {
        kind: "item",
        icon: <Folder size={13} />,
        label: t("project.showInBrowser"),
        action: () => { revealItemInDir(path).catch(() => { /* best-effort */ }); },
      },
      {
        kind: "item",
        icon: <Copy size={13} />,
        label: t("project.copyPath"),
        action: () => void navigator.clipboard.writeText(path).catch(() => { /* clipboard may be blocked */ }),
      },
      { kind: "divider" },
      {
        kind: "item",
        icon: <X size={13} />,
        label: t("project.removeRecent"),
        danger: true,
        action: () => afterUndoWindow(() => removeRecentProject(path)),
      },
    ];
  };

  const renderRow = (path: string, isPinned: boolean) => (
    <motion.li
      key={path}
      layout
      layoutId={path}
      transition={{ duration: reduced ? 0 : 0.2, ease: EASE }}
      className={styles.row}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, path });
      }}
    >
      <button
        className={styles.open}
        onClick={() => openProject(path)}
        disabled={isLoading}
        title={path}
      >
        <span className={styles.name}>{baseName(path) || path}</span>
        <span className={styles.path}>{path}</span>
        <span className={styles.time}>{openedLabel(path)}</span>
      </button>
      <button
        className={`${styles.pinBtn} ${isPinned ? styles.pinned : ""}`}
        onClick={() => togglePin(path)}
        title={t(isPinned ? "project.unpin" : "project.pin")}
        aria-label={t(isPinned ? "project.unpin" : "project.pin")}
        aria-pressed={isPinned}
      >
        <span className={`${styles.icon} ${styles.iconRest}`}>
          <Pin size={14} strokeWidth={1.5} fill={isPinned ? "currentColor" : "none"} />
        </span>
        {isPinned && (
          <span className={`${styles.icon} ${styles.iconOff}`}>
            <PinOff size={14} strokeWidth={1.5} />
          </span>
        )}
      </button>
    </motion.li>
  );

  const collapsible = pinned.length > COLLAPSE_FROM;
  const showHint = recent.length > 0 && pinned.length === 0 && !pinHintDone;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <button className={styles.openBtn} onClick={() => openProject()} disabled={isLoading}>
          <Folder size={14} strokeWidth={1.7} />
          {isLoading ? "…" : t("project.openFolder")}
        </button>
        {/* Only when there is nothing to list — with rows on screen the rail's
            job is the list, not the explanation (设计稿 15 屏 1a vs 1d①). */}
        {pinned.length === 0 && recent.length === 0 && (
          <div className={styles.blurb}>{t("project.noProjectDesc")}</div>
        )}
      </div>

      {pinned.length > 0 && (
        <>
          <div className={styles.sectionHead}>
            {collapsible ? (
              <button
                className={styles.sectionToggle}
                onClick={() => setCollapsed((c) => !c)}
                aria-expanded={!collapsed}
              >
                <span className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ""}`}>
                  <ChevronDown size={12} strokeWidth={1.8} />
                </span>
                <span className={styles.sectionLabel}>{t("project.pinnedTitle")}</span>
                <span className={styles.rule} />
                <span className={styles.count}>{pinned.length}</span>
              </button>
            ) : (
              <>
                <span className={styles.sectionLabel}>{t("project.pinnedTitle")}</span>
                <span className={styles.rule} />
              </>
            )}
          </div>
          {!collapsed && (
            <ul className={styles.list}>{pinned.map((p) => renderRow(p, true))}</ul>
          )}
        </>
      )}

      {recent.length > 0 && (
        <>
          <div className={styles.sectionHead}>
            <span className={styles.sectionLabel}>
              <span className={styles.labelFull}>{t("project.recentTitle")}</span>
              <span className={styles.labelShort}>{t("project.recentTitleShort")}</span>
            </span>
            <span className={styles.rule} />
            <button className={styles.clearBtn} onClick={onClear} disabled={isLoading}>
              <span className={styles.labelFull}>{t("project.clearRecent")}</span>
              <span className={styles.labelShort}>{t("project.clearRecentShort")}</span>
            </button>
          </div>
          <ul className={styles.list}>{recent.map((p) => renderRow(p, false))}</ul>
        </>
      )}

      <AnimatePresence initial={false}>
        {pending && (
          <motion.div
            key="undo"
            className={styles.confirm}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: reduced ? 0 : 0.16, ease: EASE } }}
            transition={{ duration: reduced ? 0 : 0.24, ease: EASE }}
          >
            <div className={styles.confirmInner}>
              <div className={styles.confirmText}>
                {t("project.cleared", { n: pending.cleared })}
                {pending.kept > 0 && (
                  <>
                    <br />
                    {t("project.clearedKept", { n: pending.kept })}
                  </>
                )}
              </div>
              <button className={styles.undo} onClick={undoClear}>
                {t("project.undoClear")}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {showHint && (
        <div className={styles.hint}>
          <Pin size={11} strokeWidth={1.6} />
          <span>{t("project.pinHint")}</span>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.path)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
