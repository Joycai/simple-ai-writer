import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Bot, CheckCircle2, History, ListTodo, RotateCw, Sparkles, X } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useAgentStore } from "../../stores/agentStore";
import { AgentChat } from "./AgentChat";
import { ModelSelector } from "./ModelSelector";
import { AiPanel } from "./AiPanel";
import { ConsistencyCheck } from "./ConsistencyCheck";
import { TaskWorkspaceView } from "./TaskWorkspaceView";
import { MOD_KEY } from "../../lib/platform";
import { drawerSlide, overlayFade, overlayFadeTransition, springDrawer } from "../../lib/motion";
import styles from "./AiDrawer.module.css";

type Mode = "generate" | "chat" | "consistency";

/** Global binding that opens each mode (see App.tsx). Shown in the header so the
 *  shortcut is discoverable from the surface it opens. */
const MODE_SHORTCUT: Record<Mode, string | null> = {
  generate: "J",
  chat: "L",
  consistency: null,
};

export function AiDrawer() {
  const { t } = useTranslation();
  const { showAiDrawer, aiDrawerMode, setShowAiDrawer } = useAppStore();

  const {
    turns, chatError, chatRunning, chatSessionId, chatSessions,
    resetChat, switchChatSession,
  } = useAgentStore();

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

  const headerTitle =
    aiDrawerMode === "consistency"
      ? t("ai.drawer.consistencyTitle", { defaultValue: "一致性检查" })
      : aiDrawerMode === "chat"
        ? t("ai.chat.title")
        : t("ai.drawer.generateTitle", { defaultValue: "AI 助手" });

  const shortcut = MODE_SHORTCUT[aiDrawerMode];

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
        variants={drawerSlide}
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
                <ListTodo size={11} strokeWidth={1.8} style={{ verticalAlign: -1.5 }} />
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
                  <History size={11} strokeWidth={1.8} style={{ verticalAlign: -1.5 }} />
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
                disabled={turns.length === 0 && !chatError}
              >
                <RotateCw size={10} strokeWidth={1.8} style={{ marginRight: 4, verticalAlign: -1 }} />
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
        </div>

        <div className={styles.body}>
          {showTasks ? (
            <TaskWorkspaceView onClose={() => setShowTasks(false)} />
          ) : aiDrawerMode === "generate" ? (
            <AiPanel />
          ) : aiDrawerMode === "chat" ? (
            <AgentChat />
          ) : (
            <ConsistencyCheck />
          )}
        </div>
      </motion.aside>
      )}
    </AnimatePresence>
  );
}
