import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Bot, CheckCircle2, Sparkles, X } from "lucide-react";
import { useAppStore, type AiDrawerMode } from "../../stores/appStore";
import { useAgentStore } from "../../stores/agentStore";
import { AgentChat } from "./AgentChat";
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

/** Global binding that opens each mode (see App.tsx). Shown in the header so the
 *  shortcut is discoverable from the surface it opens. */
const MODE_SHORTCUT: Record<Mode, string | null> = {
  generate: "J",
  chat: "L",
  consistency: null,
  roleplay: null,
};

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
  const chatRunning = useAgentStore((s) => s.chatRunning);
  const chatSessionId = useAgentStore((s) => s.chatSessionId);
  const chatSessions = useAgentStore((s) => s.chatSessions);
  const resetChat = useAgentStore((s) => s.resetChat);
  const switchChatSession = useAgentStore((s) => s.switchChatSession);
  const chatEmpty = useAgentStore((s) => s.turns.length === 0 && !s.chatError);

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
      if (!sessionsRef.current?.contains(e.target as Node)) setShowSessions(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showSessions]);

  const formatSessionTime = (unixSeconds: number) => {
    const d = new Date(unixSeconds * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

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
            <div className={styles.title}>{headerTitle}</div>
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
            {aiDrawerMode === "chat" && chatSessions.length > 0 && (
              <div className={styles.sessionMenuWrap} ref={sessionsRef}>
                <button
                  className={styles.headerBtn}
                  onClick={() => setShowSessions((v) => !v)}
                  disabled={chatRunning}
                  aria-expanded={showSessions}
                  title={t("ai.chat.history", { defaultValue: "历史会话" })}
                >
                  {t("ai.chat.history", { defaultValue: "历史会话" })}
                </button>
                {showSessions && (
                  <div className={styles.sessionMenu}>
                    {chatSessions.map((s) => (
                      <button
                        key={s.id}
                        className={`${styles.sessionItem} ${s.id === chatSessionId ? styles.sessionItemActive : ""}`}
                        onClick={() => {
                          setShowSessions(false);
                          setShowTasks(false);
                          void switchChatSession(s.id);
                        }}
                      >
                        <span className={styles.sessionPreview}>
                          {s.preview || t("ai.chat.untitledSession", { defaultValue: "（空会话）" })}
                        </span>
                        <span className={styles.sessionTime}>{formatSessionTime(s.updatedAt)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {aiDrawerMode === "chat" && (
              <button
                className={`${styles.headerBtn} ${styles.headerBtnAccent}`}
                onClick={() => {
                  setShowTasks(false);
                  resetChat();
                }}
                disabled={chatEmpty}
              >
                {t("ai.chat.newSession")}
              </button>
            )}
            {shortcut && (
              <span className={styles.shortcutHint}>
                {MOD_KEY === "⌘" ? `⌘${shortcut}` : `Ctrl ${shortcut}`}
              </span>
            )}
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

        <div className={styles.body}>
          {showTasks ? (
            <TaskWorkspaceView onClose={() => setShowTasks(false)} />
          ) : aiDrawerMode === "generate" ? (
            <AiPanel />
          ) : aiDrawerMode === "chat" ? (
            <AgentChat />
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
