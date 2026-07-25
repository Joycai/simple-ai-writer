/**
 * 对话助手 — the stage-two conversational surface of the unified agent.
 *
 * One session at a time, backed by agentStore's persistent wire history: the
 * agent's tool calls and results from earlier turns stay in context, so
 * follow-ups like "把刚才那条也改了" work. Each assistant turn embeds its own
 * execution log; manuscript edits surface as approval cards right above the
 * input while the loop waits.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw, Send, Square } from "lucide-react";
import { renderMarkdown } from "../../lib/fs/markdown";
import { useAgentStore } from "../../stores/agentStore";
import { useAiStore } from "../../stores/aiStore";
import { AgentLog } from "./AgentLog";
import { ApprovalCard } from "./ApprovalCard";
import styles from "./AgentChat.module.css";

export function AgentChat() {
  const { t } = useTranslation();
  const {
    turns, chatRunning, chatError, chatUsage, pending,
    sendChat, stopChat, resetChat,
  } = useAgentStore();
  const activeModelId = useAiStore((s) => s.activeModelId);

  const [draft, setDraft] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);

  // Follow the newest content while a turn is streaming.
  useEffect(() => {
    if (chatRunning && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [turns, chatRunning]);

  const canSend = !!draft.trim() && !chatRunning && !!activeModelId;

  const handleSend = () => {
    if (!canSend) return;
    const text = draft;
    setDraft("");
    void sendChat(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={styles.chat}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarTitle}>{t("ai.chat.sessionTitle")}</span>
        {chatUsage && (
          <span className={styles.toolbarUsage}>
            {t("ai.chat.sessionUsage", {
              input: chatUsage.inputTokens.toLocaleString(),
              output: chatUsage.outputTokens.toLocaleString(),
            })}
          </span>
        )}
        <button
          className={styles.newSessionBtn}
          onClick={resetChat}
          disabled={turns.length === 0 && !chatError}
          title={t("ai.chat.newSession")}
        >
          <RotateCw size={11} /> {t("ai.chat.newSession")}
        </button>
      </div>

      <div ref={messagesRef} className={styles.messages}>
        {turns.length === 0 && (
          <div className={styles.emptyHint}>{t("ai.chat.emptyHint")}</div>
        )}
        {turns.map((turn) =>
          turn.role === "user" ? (
            <div key={turn.id} className={styles.userTurn}>{turn.text}</div>
          ) : (
            <AssistantTurn
              key={turn.id}
              text={turn.text}
              log={turn.log}
              isLive={chatRunning && turn.id === turns[turns.length - 1]?.id}
            />
          ),
        )}
      </div>

      {chatError && <div className={styles.error}>{chatError}</div>}

      {/* Manuscript-edit approvals — the loop is blocked on these */}
      {pending.length > 0 && (
        <div className={styles.approvals}>
          {pending.map((p) => (
            <ApprovalCard key={p.proposal.id} proposal={p.proposal} />
          ))}
        </div>
      )}

      <div className={styles.inputRow}>
        <textarea
          className={styles.input}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={activeModelId ? t("ai.chat.placeholder") : t("ai.errors.noModel")}
          disabled={!activeModelId}
        />
        {chatRunning ? (
          <button className={`${styles.sendBtn} ${styles.stopBtn}`} onClick={stopChat} title={t("ai.chat.stop")}>
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button className={styles.sendBtn} onClick={handleSend} disabled={!canSend} title={t("ai.chat.send")}>
            <Send size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function AssistantTurn({ text, log, isLive }: { text: string; log: import("../../lib/agent/events").AgentEvent[]; isLive: boolean }) {
  const { t } = useTranslation();
  // Markdown render is cheap at chat sizes; memo keeps streaming smooth anyway.
  const html = useMemo(() => renderMarkdown(text), [text]);

  return (
    <div className={styles.assistantTurn}>
      {log.length > 0 && <AgentLog log={log} isRunning={isLive} />}
      {text ? (
        <div className={styles.assistantBody} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        isLive && (
          <div className={styles.thinking}>
            <span className={styles.thinkingSpinner} />
            {t("ai.chat.thinking")}
          </div>
        )
      )}
    </div>
  );
}
