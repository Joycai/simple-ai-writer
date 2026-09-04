/**
 * 换项目 while conversations are still working (设计稿 23 屏 1j).
 *
 * The single-conversation drawer never asked: the author could see the one
 * run. With several on background tabs they may not remember, so when any is
 * generating, queued, folding or waiting on a card, the switch asks once and
 * lists them — each with what will happen to it, on the row, not hidden in the
 * note. Everything idle: no dialog (agentStore.confirmProjectSwitch resolves at
 * once). Esc and the backdrop mean 留下.
 */
import { useTranslation } from "react-i18next";
import {
  chatQueuePosition, chatStateOf, useAgentStore, type LiveChat,
} from "../../stores/agentStore";
import { liveLabel, roundsOf } from "../../lib/agent/chatLabel";
import type { ChatState } from "../../lib/agent/chatState";
import { ModalShell } from "../common/ModalShell";
import { ChatMark } from "./ChatMark";
import styles from "./ChatSwitchGuard.module.css";

interface BusyRow {
  key: string;
  chat: LiveChat;
  state: ChatState | null;
  compacting: boolean;
  rounds: number;
  queuePos: number;
}

export function ChatSwitchGuard() {
  const { t } = useTranslation();
  const guard = useAgentStore((s) => s.projectSwitchGuard);
  const rows = useAgentStore((s): BusyRow[] =>
    s.chatOrder.flatMap((key) => {
      const chat = s.chats[key];
      if (!chat) return [];
      const state = chatStateOf(s, key);
      const compacting = s.compactingChats.includes(key);
      if (!compacting && state !== "running" && state !== "queued" && state !== "waiting") return [];
      const last = [...chat.turns].reverse().find((tn) => tn.role === "assistant");
      return [{ key, chat, state, compacting, rounds: last ? roundsOf(last.log) : 0, queuePos: chatQueuePosition(s, key) }];
    }),
  );
  if (!guard) return null;

  const queued = rows.filter((r) => r.state === "queued").length;
  const title = guard.target === null
    ? t("ai.chat.switchGuardClose", { n: rows.length, defaultValue: `关闭项目会停掉这里正在跑的 ${rows.length} 段会话` })
    : t("ai.chat.switchGuardTitle", { name: guard.target, n: rows.length, defaultValue: `切到《${guard.target}》会停掉这里正在跑的 ${rows.length} 段会话` });

  const rowNote = (r: BusyRow): string => {
    if (r.state === "waiting") return t("ai.chat.switchRowWaiting", { defaultValue: "等你批准 · 会按拒绝处理" });
    if (r.state === "queued") return t("ai.chat.switchRowQueued", { defaultValue: "排队 · 退回草稿" });
    if (r.compacting) return t("ai.chat.switchRowCompacting", { defaultValue: "归纳中 · 保留归纳前的对话" });
    return t("ai.chat.switchRowRunning", { n: r.rounds, defaultValue: `第 ${r.rounds} 轮 · 写到哪算哪` });
  };

  return (
    <ModalShell overlayClassName={styles.overlay} onClose={() => guard.resolve(false)}>
      <div className={styles.panel} role="alertdialog" aria-labelledby="chat-switch-guard-title">
        <div id="chat-switch-guard-title" className={styles.title}>{title}</div>
        <div className={styles.rows}>
          {rows.map((r) => {
            const label = liveLabel(r.chat);
            return (
              <div key={r.key} className={styles.row}>
                <span className={styles.mark}><ChatMark state={r.compacting && !r.state ? "running" : r.state} /></span>
                <span className={`${styles.label} ${styles[`label_${label.kind}`]}`}>
                  {label.kind === "preview" && <span className={styles.quote}>“</span>}
                  {label.kind === "none" ? t("ai.chat.untitledTab", { defaultValue: "未命名" }) : label.text}
                </span>
                <span className={`${styles.note} ${r.state === "waiting" ? styles.noteAccent : ""}`}>{rowNote(r)}</span>
              </div>
            );
          })}
        </div>
        <div className={styles.footnote}>
          {queued > 0
            ? t("ai.chat.switchGuardNote", { n: queued, defaultValue: `对话都留在这个项目的历史里，回来能接着看；排队的 ${queued} 段退回草稿。` })
            : t("ai.chat.switchGuardNoteNoQueue", { defaultValue: "对话都留在这个项目的历史里，回来能接着看。" })}
        </div>
        <div className={styles.actions}>
          <span className={styles.kbd}>{t("ai.chat.switchGuardEsc", { defaultValue: "Esc 留下" })}</span>
          <div className={styles.spacer} />
          <button type="button" className={styles.stay} onClick={() => guard.resolve(false)} autoFocus>
            {t("ai.chat.switchGuardStay", { defaultValue: "留下" })}
          </button>
          <button type="button" className={styles.go} onClick={() => guard.resolve(true)}>
            {guard.target === null
              ? t("ai.chat.switchGuardStopAndClose", { defaultValue: "停掉并关闭" })
              : t("ai.chat.switchGuardStopAndSwitch", { defaultValue: "停掉并切换" })}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
