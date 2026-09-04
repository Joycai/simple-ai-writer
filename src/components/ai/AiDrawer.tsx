import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Bot, CheckCircle2, Sparkles, X } from "lucide-react";
import { useAppStore, type AiDrawerMode } from "../../stores/appStore";
import { mostUrgentChatState, useAgentStore } from "../../stores/agentStore";
import { comboLabel, matchesCombo, type Combo } from "../../lib/shortcuts";
import { AgentChat } from "./AgentChat";
import { ChatMark } from "./ChatMark";
import { SessionMenu } from "./SessionMenu";
import { SessionTabs } from "./SessionTabs";
import { SessionTitle } from "./SessionTitle";
import { ModelSelector } from "./ModelSelector";
import { AiPanel } from "./AiPanel";
import { ConsistencyCheck } from "./ConsistencyCheck";
import { RoleplayPanel } from "../roleplay/RoleplayPanel";
import { isRoleplayEnabled } from "../../lib/roleplay/flag";
import { useRoleplayStore } from "../../stores/roleplayStore";
import { TaskWorkspaceView } from "./TaskWorkspaceView";
import { MOD_KEY } from "../../lib/platform";
import { drawerSlide, overlayFade, overlayFadeTransition, springDrawer, useMotionPreset } from "../../lib/motion";
import styles from "./AiDrawer.module.css";

type Mode = AiDrawerMode;

/** Global binding that reaches each mode (see useGlobalShortcuts). Shown in the
 *  header so the shortcut is discoverable from the surface it opens.
 *
 *  ⌘J opens no particular tab — it reopens the drawer on the last one used — so
 *  it is the honest hint on every tab that has no opener of its own. 对话 keeps
 *  ⌘L, which lands there whatever tab was last. */
const MODE_SHORTCUT: Record<Mode, string> = {
  generate: "J",
  chat: "L",
  consistency: "J",
  roleplay: "J",
};

/** 新会话 — bound while the drawer is open on 对话助手 (设计稿 23 屏 1a). */
const NEW_CHAT_COMBO: Combo = { mod: true, key: "n" };

export function AiDrawer() {
  const { t } = useTranslation();
  const showAiDrawer = useAppStore((s) => s.showAiDrawer);
  const aiDrawerMode = useAppStore((s) => s.aiDrawerMode);
  const setShowAiDrawer = useAppStore((s) => s.setShowAiDrawer);

  // Field selectors: this component is always mounted (the drawer animates in
  // and out), and a whole-store subscription re-rendered it — header,
  // ModelSelector and all — on every streamed token of a background chat,
  // even while closed. `turns` is deliberately reduced to the one boolean the
  // header reads, so the per-token turn patches don't reach it either.
  const activeChatKey = useAgentStore((s) => s.activeChatKey);
  const newChat = useAgentStore((s) => s.newChat);
  // The mode tab carries the one most urgent mark for every conversation while
  // the author is on another mode (设计稿 23 屏 1d): 等作者 over 有结果 over 在跑.
  const chatMark = useAgentStore((s) => (aiDrawerMode === "chat" ? null : mostUrgentChatState(s)));

  const close = () => setShowAiDrawer(false);
  const setMode = (m: Mode) => {
    setShowTasks(false);
    setShowAiDrawer(true, m);
  };

  // ── Session history menu ──
  const [showSessions, setShowSessions] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const sessionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showSessions) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // The menu's own right-click menu is portaled to <body>: a click on it is
      // not "outside", or the action it carries would land on a closed menu.
      if (target?.closest?.("[data-context-menu]")) return;
      if (!sessionsRef.current?.contains(e.target as Node)) setShowSessions(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showSessions]);

  // 新会话: always available. Landing on a tab that already existed (the idle
  // empty one) flashes that tab's top line once instead of opening a second
  // blank one (设计稿 23 屏 1g).
  const [flash, setFlash] = useState<{ key: string; seq: number } | null>(null);
  const openNewChat = () => {
    setShowTasks(false);
    setShowSessions(false);
    const before = useAgentStore.getState().chatOrder;
    const key = newChat();
    if (before.includes(key)) setFlash((f) => ({ key, seq: (f?.seq ?? 0) + 1 }));
  };
  useEffect(() => {
    if (!showAiDrawer || aiDrawerMode !== "chat") return;
    const onKey = (e: KeyboardEvent) => {
      if (!matchesCombo(e, NEW_CHAT_COMBO)) return;
      e.preventDefault();
      openNewChat();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openNewChat reads the store directly
  }, [showAiDrawer, aiDrawerMode]);

  // 一个 Beta 开关，读一次就够：它只会在设置页被改，而改完抽屉会重挂。
  const roleplayOn = isRoleplayEnabled();
  const roleplayUnread = useRoleplayStore(
    (s) => s.order.some((id) => s.unread[id]) || s.running.length > 0,
  );

  const headerTitle =
    aiDrawerMode === "roleplay"
      ? t("roleplay.title", { defaultValue: "扮演" })
      : aiDrawerMode === "consistency"
      ? t("ai.drawer.consistencyTitle", { defaultValue: "一致性检查" })
      : aiDrawerMode === "chat"
        ? t("ai.chat.title")
        : t("ai.drawer.generateTitle", { defaultValue: "AI 助手" });

  const shortcut = MODE_SHORTCUT[aiDrawerMode];
  const drawerVariants = useMotionPreset(drawerSlide);

  return (
    <AnimatePresence>
      {showAiDrawer && (
        <motion.div
          key="ai-backdrop"
          className={styles.backdrop}
          onClick={close}
          variants={overlayFade}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={overlayFadeTransition}
        />
      )}
      {showAiDrawer && (
      <motion.aside
        key="ai-drawer"
        className={styles.drawer}
        role="dialog"
        aria-modal
        data-ai-surface
        variants={drawerVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        transition={springDrawer}
      >
        <div className={styles.header}>
          <div className={styles.avatar}>
            {aiDrawerMode === "consistency"
              ? <CheckCircle2 size={16} strokeWidth={1.6} />
              : aiDrawerMode === "chat"
                ? <Bot size={16} strokeWidth={1.6} />
                : <Sparkles size={16} strokeWidth={1.6} />}
          </div>

          <div className={styles.titleBlock}>
            {/* 对话助手 mode: the conversation's *name* is the title — 「对话助手」is
                already lit on the mode tab (设计稿 23 屏 1f). */}
            {aiDrawerMode === "chat" ? <SessionTitle /> : <div className={styles.title}>{headerTitle}</div>}
            <div className={styles.subtitle}>
              <ModelSelector />
            </div>
          </div>

          <div className={styles.headerActions}>
            {aiDrawerMode === "chat" && (
              <button
                className={`${styles.headerBtn} ${showTasks ? styles.headerBtnAccent : ""}`}
                onClick={() => setShowTasks((v) => !v)}
                title={t("ai.taskWorkspace.title", { defaultValue: "任务工作区" })}
              >
                {t("ai.drawer.tasksAction", { defaultValue: "任务" })}
              </button>
            )}
            {aiDrawerMode === "chat" && (
              <div className={styles.sessionMenuWrap} ref={sessionsRef}>
                <button
                  className={styles.headerBtn}
                  onClick={() => setShowSessions((v) => !v)}
                  aria-expanded={showSessions}
                  title={t("ai.chat.history", { defaultValue: "历史会话" })}
                >
                  {t("ai.chat.history", { defaultValue: "历史会话" })}
                </button>
                {showSessions && <SessionMenu onClose={() => setShowSessions(false)} />}
              </div>
            )}
            {aiDrawerMode === "chat" && (
              // Always live: on an empty tab it focuses that tab (flash) rather
              // than adding a second empty one.
              <button
                className={`${styles.headerBtn} ${styles.headerBtnAccent} ${styles.newChatBtn}`}
                onClick={openNewChat}
                title={t("ai.chat.newSessionTitle", { defaultValue: "新开一段对话；已有一个空标签时是聚焦它" })}
              >
                {t("ai.chat.newSession")}
                <span className={styles.newChatKey}>{comboLabel(NEW_CHAT_COMBO)}</span>
              </button>
            )}
            <span className={styles.shortcutHint}>
              {MOD_KEY === "⌘" ? `⌘${shortcut}` : `Ctrl ${shortcut}`}
            </span>
            <button className={styles.closeBtn} onClick={close} aria-label="Close">
              <X size={15} strokeWidth={1.6} />
            </button>
          </div>
        </div>

        <div className={styles.modeTabs}>
          <button
            className={`${styles.modeTab} ${aiDrawerMode === "generate" ? styles.modeTabActive : ""}`}
            onClick={() => setMode("generate")}
          >
            {t("ai.drawer.tabGenerate", { defaultValue: "生成" })}
          </button>
          <button
            className={`${styles.modeTab} ${aiDrawerMode === "chat" ? styles.modeTabActive : ""}`}
            onClick={() => setMode("chat")}
          >
            {t("ai.chat.title")}
            {chatMark && <span className={styles.modeTabMark}><ChatMark state={chatMark} size="mode" /></span>}
          </button>
          <button
            className={`${styles.modeTab} ${aiDrawerMode === "consistency" ? styles.modeTabActive : ""}`}
            onClick={() => setMode("consistency")}
          >
            {t("ai.drawer.consistencyTitle", { defaultValue: "一致性检查" })}
          </button>
          {/* 扮演永远是一个平级 tab，不折进「更多」——它是一种模式，不是一个
              工具，而作者切进切出的频率最高（设计稿 08 屏 1i）。 */}
          {roleplayOn && (
            <button
              className={`${styles.modeTab} ${aiDrawerMode === "roleplay" ? styles.modeTabActive : ""}`}
              onClick={() => setMode("roleplay")}
            >
              {t("roleplay.title", { defaultValue: "扮演" })}
              {roleplayUnread && aiDrawerMode !== "roleplay" && <span className={styles.modeTabDot} />}
            </button>
          )}
        </div>

        {/* 标签条: the open conversations, between the mode tabs and the
            conversation (设计稿 23 屏 1a). Only in 对话助手, never over the task view. */}
        {aiDrawerMode === "chat" && !showTasks && (
          <SessionTabs flash={flash} onOverflow={() => setShowSessions(true)} />
        )}

        <div className={styles.body}>
          {showTasks ? (
            <TaskWorkspaceView onClose={() => setShowTasks(false)} />
          ) : aiDrawerMode === "generate" ? (
            <AiPanel />
          ) : aiDrawerMode === "chat" ? (
            // Keyed by conversation: switching tabs remounts the chat, so
            // per-mount state (scroll, folds, rewind pick) starts clean.
            <AgentChat key={activeChatKey} />
          ) : aiDrawerMode === "roleplay" ? (
            <RoleplayPanel />
          ) : (
            <ConsistencyCheck />
          )}
        </div>
      </motion.aside>
      )}
    </AnimatePresence>
  );
}
