/**
 * 标签条 — the open conversations, one index tab each (设计稿 23 屏 1a/1d/1g).
 *
 * 38px, between the mode tabs and the conversation. A conversation has no
 * face, so a tab tells it apart by two things only: what it is *called*
 * (lib/agent/chatLabel — the author's title upright and bright, the first
 * question dim behind an opening quote, 未命名 faintest) and how it is *doing*
 * right now (ChatMark — one colour, three shape families). Nothing else rides
 * on a tab: no usage, no model. Those live on the context bar and in the
 * history menu.
 *
 * The current tab shares the conversation's background, carries the 2px
 * sienna top line and eats the strip's bottom hairline — a slip of paper
 * actually stuck to the manuscript; the others are parted by single
 * hairlines. Hover is neutral grey, selection is the accent line: different
 * sources, never confused (设计系统 · 选中 vs 悬停).
 *
 * Closing is not deleting — the row stays in the history — and closing a
 * conversation that is generating is two steps in place: the tab turns into
 * the question「还在生成。停止并关闭？」 for as long as it takes to answer, and
 * Esc or 留着 turns it back. Tabs shrink to 120px and no further; the ones
 * that would not fit fold into a「+N」at the right end, which opens the
 * history menu on its 已打开 section.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import {
  chatQueuePosition, chatStateOf, chatWaitingSince, isChatBusy, useAgentStore,
} from "../../stores/agentStore";
import { MAX_CONCURRENT_RUNS } from "../../lib/agent/scheduler";
import { elapsedClock, liveLabel, roundsOf } from "../../lib/agent/chatLabel";
import type { ChatState } from "../../lib/agent/chatState";
import { ChatMark } from "./ChatMark";
import styles from "./SessionTabs.module.css";

/** A tab never gets narrower than this; past it, tabs fold into 「+N」. */
const MIN_TAB = 120;
/** Padding + concurrency readout + the overflow button, in px. */
const RESERVED = 52 + 210 + 48;

export function SessionTabs({ onOverflow, flash }: {
  /** 「+N」pressed: open the history menu (on its 已打开 section). */
  onOverflow: () => void;
  /** Bumped when 新会话 landed on a tab that already existed — it flashes its top line once. */
  flash: { key: string; seq: number } | null;
}) {
  const { t } = useTranslation();
  const chatOrder = useAgentStore((s) => s.chatOrder);
  const activeKey = useAgentStore((s) => s.activeChatKey);
  const runningCount = useAgentStore((s) => s.runningChats.length);
  const queuedCount = useAgentStore((s) => s.chatQueue.length);

  // How many tabs fit: measured, not guessed, because the drawer is 94vw on a
  // laptop and 1180 on a desktop.
  const stripRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1180);
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  const fit = Math.max(1, Math.floor((width - RESERVED) / MIN_TAB));
  let visible = chatOrder.slice(0, fit);
  // The active conversation is always on the strip — the author is looking at
  // it — so it takes the last slot from whichever tab would have had it.
  if (!visible.includes(activeKey) && chatOrder.includes(activeKey)) {
    visible = [...visible.slice(0, Math.max(0, fit - 1)), activeKey];
  }
  const hidden = chatOrder.length - visible.length;

  return (
    <div ref={stripRef} className={styles.strip} role="tablist">
      {visible.map((key) => (
        <SessionTab
          key={key}
          chatKey={key}
          active={key === activeKey}
          flashSeq={flash?.key === key ? flash.seq : 0}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className={styles.overflow}
          onClick={onOverflow}
          title={t("ai.chat.moreTabsTitle", { n: hidden, defaultValue: `还有 ${hidden} 段打开着 · 在历史会话里` })}
        >
          +{hidden}
        </button>
      )}
      <div className={styles.spacer} />
      {/* 并发 ▮▮▯ 2 / 3 · 排队 1 — the roster's own vocabulary, in the roster's
          mono; the「排队 1」and the hollow ring on the fourth tab annotate each other. */}
      <div className={styles.readout} aria-label={t("ai.chat.concurrency", { defaultValue: "并发" })}>
        <span>{t("ai.chat.concurrency", { defaultValue: "并发" })}</span>
        <span className={styles.slots}>
          {Array.from({ length: MAX_CONCURRENT_RUNS }, (_, i) => (
            <span key={i} className={i < runningCount ? styles.slotOn : styles.slotOff} />
          ))}
        </span>
        <span className={styles.readoutValue}>{runningCount} / {MAX_CONCURRENT_RUNS}</span>
        {queuedCount > 0 && (
          <>
            <span className={styles.readoutDot}>·</span>
            <span>
              {t("ai.chat.queuedCountLabel", { defaultValue: "排队" })}{" "}
              <span className={styles.readoutValue}>{queuedCount}</span>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One tab. Subscribes to primitives only — the label text and the state name
 * — so the per-token turn patches of a streaming conversation never reach it.
 */
function SessionTab({ chatKey, active, flashSeq }: {
  chatKey: string;
  active: boolean;
  flashSeq: number;
}) {
  const { t } = useTranslation();
  const labelKind = useAgentStore((s) => {
    const c = s.chats[chatKey];
    return c ? liveLabel(c).kind : "none";
  });
  const labelText = useAgentStore((s) => {
    const c = s.chats[chatKey];
    return c ? liveLabel(c).text : "";
  });
  const state = useAgentStore((s) => chatStateOf(s, chatKey));
  const busy = useAgentStore((s) => isChatBusy(s, chatKey));
  const queuePos = useAgentStore((s) => chatQueuePosition(s, chatKey));
  const rounds = useAgentStore((s) => {
    const c = s.chats[chatKey];
    const last = c ? [...c.turns].reverse().find((tn) => tn.role === "assistant") : null;
    return last ? roundsOf(last.log) : 0;
  });
  const waitingSince = useAgentStore((s) => chatWaitingSince(s, chatKey));
  const activateChat = useAgentStore((s) => s.activateChat);
  const closeChat = useAgentStore((s) => s.closeChat);
  const stopChat = useAgentStore((s) => s.stopChat);

  // Two-step close, in place (设计稿 23 屏 1d last row).
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAsking(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking]);
  // A busy tab that settled on its own while the question stood: the question
  // no longer applies.
  useEffect(() => { if (!busy) setAsking(false); }, [busy]);

  const now = useNow(state === "waiting" ? 1000 : 0);
  const title = describe(t, state, {
    rounds, queuePos, waiting: waitingSince ? elapsedClock(waitingSince, now) : null, active,
  });

  // The flash: a key change on the element restarts the CSS animation.
  const flashRef = useRef(0);
  const flashing = flashSeq > 0 && flashSeq !== flashRef.current;
  useEffect(() => { if (flashSeq) flashRef.current = flashSeq; }, [flashSeq]);

  const onClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) { setAsking(true); return; }
    void closeChat(chatKey);
  };

  if (asking) {
    return (
      <div className={`${styles.tab} ${styles.tabAsking}`} role="presentation">
        <ChatMark state={state} />
        <span className={styles.askText}>
          {t("ai.chat.closeRunningAsk", { defaultValue: "还在生成。停止并关闭？" })}
        </span>
        <button
          type="button"
          className={styles.askConfirm}
          onClick={() => { stopChat(chatKey); void closeChat(chatKey); }}
        >
          {t("ai.chat.stopAndClose", { defaultValue: "停止并关闭" })}
        </button>
        <button type="button" className={styles.askKeep} onClick={() => setAsking(false)}>
          {t("ai.chat.keepTab", { defaultValue: "留着" })}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`${styles.tab} ${active ? styles.tabActive : ""} ${flashing ? styles.tabFlash : ""}`}
      key={flashSeq}
      role="tab"
      aria-selected={active}
      title={title}
      onClick={() => activateChat(chatKey)}
      onAuxClick={(e) => { if (e.button === 1) onClose(e); }}
    >
      {/* No unread square on the current tab — the author is looking at it. */}
      <ChatMark state={active && (state === "unread" || state === "error") ? null : state} />
      <span className={`${styles.label} ${styles[`label_${labelKind}`]}`}>
        {labelKind === "preview" && <span className={styles.quote}>“</span>}
        {labelKind === "none"
          ? t("ai.chat.untitledTab", { defaultValue: "未命名" })
          : labelText}
      </span>
      <button
        type="button"
        className={styles.close}
        onClick={onClose}
        aria-label={t("ai.chat.closeTab", { defaultValue: "关闭标签 · 不删除" })}
        title={busy
          ? t("ai.chat.closeTabBusy", { defaultValue: "关闭会先停止" })
          : t("ai.chat.closeTab", { defaultValue: "关闭标签 · 不删除" })}
      >
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}

function describe(
  t: (k: string, o?: Record<string, unknown>) => string,
  state: ChatState | null,
  x: { rounds: number; queuePos: number; waiting: string | null; active: boolean },
): string {
  switch (state) {
    case "running":
      return t("ai.chat.tabRunning", { n: x.rounds, defaultValue: `正在生成 · 第 ${x.rounds} 轮 · 关闭会先停止` });
    case "queued":
      return t("ai.chat.tabQueued", { n: x.queuePos, defaultValue: `排队 · 前面还有 ${x.queuePos} 段 · 并发已满` });
    case "waiting":
      return t("ai.chat.tabWaiting", { t: x.waiting ?? "", defaultValue: `等你批准 · 停了 ${x.waiting ?? ""}` });
    case "unread":
      return t("ai.chat.tabUnread", { defaultValue: "跑完了，有新回复" });
    case "error":
      return t("ai.chat.tabError", { defaultValue: "出错了" });
    default:
      return x.active ? t("ai.chat.tabCurrent", { defaultValue: "当前" }) : "";
  }
}

/** A ticking clock, only while something on screen counts. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!intervalMs) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
