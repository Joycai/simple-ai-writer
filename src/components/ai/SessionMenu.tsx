/**
 * 历史会话 — the drawer header's dropdown (设计稿 23 屏 1e).
 *
 * Three sections, and a conversation appears in exactly one of them:
 *   已打开   the tabs, with their live marks — the only section whose label is
 *            set in sienna; a row here is *切到 ›*, not 打开, because it will
 *            not open a second time
 *   已固定   saved and pinned
 *   最近     saved, unpinned, capped — the footnote says by what rule, and that
 *            naming or pinning is the way out of it
 *
 * There is deliberately no 已命名 section: naming shows in the *type* (the
 * author's words upright and bright, the first question dim behind a quote —
 * lib/agent/chatLabel), and what naming buys is written under 最近.
 *
 * Actions come two ways to the same three verbs — hover icons at the row's end
 * (the roster's pattern) and a right-click menu (the file tree's) — and every
 * one of them happens *in place*: delete turns the row into its question with
 * the conversation's name in it (「删除」in sienna, never red), rename turns the
 * label into the field. A conversation that is generating cannot be deleted;
 * the icon greys out and says so.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Pin, Search, Trash2 } from "lucide-react";
import {
  chatQueuePosition, chatStateOf, chatWaitingSince, isChatBusy, useAgentStore, type LiveChat,
} from "../../stores/agentStore";
import {
  MAX_SESSION_TITLE_CHARS, normalizeSessionTitle, splitChatSessions, type ChatSessionRow,
} from "../../lib/agent/sessionDb";
import { elapsedClock, liveLabel, roundsOf, rowLabel, type ChatLabel } from "../../lib/agent/chatLabel";
import type { ChatState } from "../../lib/agent/chatState";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import { ChatMark } from "./ChatMark";
import { useNow } from "./SessionTabs";
import styles from "./SessionMenu.module.css";

interface OpenEntry {
  kind: "open";
  key: string;
  sessionId: number | null;
  label: ChatLabel;
  pinned: boolean;
  state: ChatState | null;
  active: boolean;
}
interface SavedEntry {
  kind: "saved";
  row: ChatSessionRow;
  label: ChatLabel;
}
type Entry = OpenEntry | SavedEntry;

type Editing =
  | { kind: "rename"; id: string; initial: string }
  | { kind: "delete"; id: string }
  | null;

const entryId = (e: Entry) => (e.kind === "open" ? `k:${e.key}` : `r:${e.row.id}`);

export function SessionMenu({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const rows = useAgentStore((s) => s.chatSessions);
  // One subscription for the open conversations' labels/states — the menu is
  // open briefly, so re-rendering it per token is acceptable here where it is
  // not on the always-mounted strip.
  const openEntries = useAgentStore((s): OpenEntry[] =>
    s.chatOrder.map((key) => {
      const c = s.chats[key];
      const row = c?.sessionId != null ? s.chatSessions.find((r) => r.id === c.sessionId) : undefined;
      return {
        kind: "open",
        key,
        sessionId: c?.sessionId ?? null,
        label: c ? liveLabel(c) : { text: "", kind: "none" },
        pinned: row?.pinned ?? false,
        state: chatStateOf(s, key),
        active: key === s.activeChatKey,
      };
    }),
  );
  const activateChat = useAgentStore((s) => s.activateChat);
  const switchChatSession = useAgentStore((s) => s.switchChatSession);
  const toggleChatSessionPin = useAgentStore((s) => s.toggleChatSessionPin);
  const renameChat = useAgentStore((s) => s.renameChat);
  const renameSession = useAgentStore((s) => s.renameSession);
  const deleteChatSession = useAgentStore((s) => s.deleteChatSession);

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { searchRef.current?.focus(); }, []);

  const openIds = useMemo(
    () => new Set(openEntries.map((e) => e.sessionId).filter((id): id is number => id !== null)),
    [openEntries],
  );
  const saved = useMemo(() => rows.filter((r) => !openIds.has(r.id)), [rows, openIds]);
  const { pinned, recent } = splitChatSessions(saved);
  const q = query.trim().toLowerCase();
  const matches = (l: ChatLabel, alt = "") =>
    !q || l.text.toLowerCase().includes(q) || alt.toLowerCase().includes(q);
  const open = openEntries.filter((e) => matches(e.label));
  const pinnedE: SavedEntry[] = pinned
    .map((row) => ({ kind: "saved" as const, row, label: rowLabel(row) }))
    .filter((e) => matches(e.label, e.row.preview));
  const recentE: SavedEntry[] = recent
    .map((row) => ({ kind: "saved" as const, row, label: rowLabel(row) }))
    .filter((e) => matches(e.label, e.row.preview));
  const total = openEntries.length + saved.length;

  const goTo = (e: Entry) => {
    onClose();
    if (e.kind === "open") activateChat(e.key);
    else void switchChatSession(e.row.id);
  };
  const sessionIdOf = (e: Entry) => (e.kind === "open" ? e.sessionId : e.row.id);
  const busyOf = (e: Entry) =>
    e.kind === "open" && isChatBusy(useAgentStore.getState(), e.key);

  const startRename = (e: Entry) =>
    setEditing({ kind: "rename", id: entryId(e), initial: e.kind === "open" ? (useAgentStore.getState().chats[e.key]?.title ?? "") : e.row.title });
  const startDelete = (e: Entry) => {
    if (sessionIdOf(e) === null || busyOf(e)) return;
    setEditing({ kind: "delete", id: entryId(e) });
  };
  const commitRename = (e: Entry, raw: string) => {
    setEditing(null);
    const clean = normalizeSessionTitle(raw);
    if (e.kind === "open") void renameChat(clean, e.key);
    else void renameSession(e.row.id, clean);
  };
  const commitDelete = (e: Entry) => {
    setEditing(null);
    const id = sessionIdOf(e);
    if (id !== null) void deleteChatSession(id);
  };

  const contextItems = (e: Entry): ContextMenuEntry[] => {
    const id = sessionIdOf(e);
    const isPinned = e.kind === "open" ? e.pinned : e.row.pinned;
    const busy = busyOf(e);
    return [
      {
        kind: "item",
        icon: <Pin size={13} />,
        label: t(isPinned ? "ai.chat.unpinSession" : "project.pin", { defaultValue: isPinned ? "取消固定" : "固定" }),
        disabled: id === null,
        action: () => { if (id !== null) void toggleChatSessionPin(id); },
      },
      { kind: "item", icon: <Pencil size={13} />, label: t("ai.chat.rename", { defaultValue: "改名" }), action: () => startRename(e) },
      { kind: "divider" },
      {
        kind: "item",
        icon: <Trash2 size={13} />,
        label: busy
          ? t("ai.chat.deleteBlockedRunning", { defaultValue: "正在生成 · 先停止" })
          : t("ai.chat.deleteSession", { defaultValue: "删除" }),
        danger: true,
        disabled: id === null || busy,
        action: () => startDelete(e),
      },
    ];
  };

  const renderRow = (e: Entry) => {
    const id = entryId(e);
    if (editing?.kind === "rename" && editing.id === id) {
      return (
        <RenameRow
          key={id}
          entry={e}
          initial={editing.initial}
          onCommit={(v) => commitRename(e, v)}
          onCancel={() => setEditing(null)}
        />
      );
    }
    if (editing?.kind === "delete" && editing.id === id) {
      return (
        <div key={id} className={`${styles.row} ${styles.rowConfirm}`}>
          <ChatMark state={e.kind === "open" ? e.state : null} />
          <span className={styles.confirmText}>
            {t("ai.chat.deleteConfirmLead", { defaultValue: "删除「" })}
            <span className={styles.confirmName}>
              {e.label.text || t("ai.chat.untitledTab", { defaultValue: "未命名" })}
            </span>
            {t("ai.chat.deleteConfirmTail", { defaultValue: "」？不可恢复" })}
          </span>
          <button type="button" className={styles.confirmDelete} onClick={() => commitDelete(e)}>
            {t("ai.chat.deleteSession", { defaultValue: "删除" })}
          </button>
          <button type="button" className={styles.confirmCancel} onClick={() => setEditing(null)}>
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
        </div>
      );
    }
    return (
      <SessionRow
        key={id}
        entry={e}
        onGo={() => goTo(e)}
        onPin={sessionIdOf(e) !== null ? () => { const sid = sessionIdOf(e); if (sid !== null) void toggleChatSessionPin(sid); } : undefined}
        onRename={() => startRename(e)}
        onDelete={sessionIdOf(e) !== null ? () => startDelete(e) : undefined}
        onContextMenu={(x, y) => setMenu({ x, y, entry: e })}
      />
    );
  };

  return (
    <div
      className={styles.menu}
      role="menu"
      onKeyDown={(e) => { if (e.key === "Escape" && !editing) { e.stopPropagation(); onClose(); } }}
    >
      <div className={styles.search}>
        <Search size={12} strokeWidth={1.8} className={styles.searchIcon} />
        <input
          ref={searchRef}
          className={styles.searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("ai.chat.searchSessions", { defaultValue: "搜会话名或第一句…" })}
        />
        <span className={styles.count}>{t("ai.chat.sessionCount", { n: total, defaultValue: `${total} 段` })}</span>
      </div>

      {open.length > 0 && (
        <>
          <div className={`${styles.group} ${styles.groupOpen}`}>
            <span>{t("ai.chat.openSessions", { defaultValue: "已打开" })}</span>
            <span className={styles.groupCount}>{open.length}</span>
          </div>
          {open.map(renderRow)}
        </>
      )}
      {pinnedE.length > 0 && (
        <>
          <div className={styles.group}>
            <span>{t("ai.chat.pinnedSessions", { defaultValue: "已固定" })}</span>
            <span className={styles.groupCount}>{pinnedE.length}</span>
          </div>
          {pinnedE.map(renderRow)}
        </>
      )}
      {recentE.length > 0 && (
        <>
          <div className={styles.group}>
            <span>{t("ai.chat.recentSessions", { defaultValue: "最近" })}</span>
            <span className={styles.groupCount}>{recentE.length}</span>
          </div>
          {recentE.map(renderRow)}
          <div className={styles.footnote}>
            {t("ai.chat.recentFootnote", { defaultValue: "未命名、未固定的只留 5 条，多了自动清掉。起个名或钉住就不清。" })}
          </div>
        </>
      )}
      {open.length === 0 && pinnedE.length === 0 && recentE.length === 0 && (
        <div className={styles.footnote}>{t("ai.chat.searchNoMatch", { defaultValue: "没有匹配的会话" })}</div>
      )}
      <div className={styles.footer}>
        <span>{t("ai.chat.menuFooter", { defaultValue: "右键任一行：固定 · 改名 · 删除" })}</span>
        <span className={styles.kbd}>Esc</span>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={contextItems(menu.entry)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function SessionRow({ entry, onGo, onPin, onRename, onDelete, onContextMenu }: {
  entry: Entry;
  onGo: () => void;
  onPin?: () => void;
  onRename: () => void;
  onDelete?: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const isOpen = entry.kind === "open";
  const pinned = isOpen ? entry.pinned : entry.row.pinned;
  const state = isOpen ? entry.state : null;
  const openKey = isOpen ? entry.key : null;
  const busy = useAgentStore((s) => (openKey ? isChatBusy(s, openKey) : false));
  const status = useAgentStore((s) => (openKey ? statusText(t, s, openKey, s.chats[openKey]) : null));
  const now = useNow(state === "waiting" ? 1000 : 0);
  const waitingSince = useAgentStore((s) => (openKey ? chatWaitingSince(s, openKey) : null));
  const right = isOpen
    ? entry.active
      ? t("ai.chat.tabCurrent", { defaultValue: "当前" })
      : state === "waiting" && waitingSince
        ? t("ai.chat.stateWaiting", { t: elapsedClock(waitingSince, now), defaultValue: `等你 · ${elapsedClock(waitingSince, now)}` })
        : status
    : formatSessionTime(entry.row.updatedAt);

  return (
    <div
      className={`${styles.row} ${isOpen && entry.active ? styles.rowActive : ""}`}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e.clientX, e.clientY); }}
    >
      <button type="button" className={styles.rowMain} onClick={onGo}>
        <span className={styles.rowMark}>
          <ChatMark state={isOpen && entry.active ? null : state} />
        </span>
        <span className={`${styles.label} ${styles[`label_${entry.label.kind}`]}`}>
          {entry.label.kind === "preview" && <span className={styles.quote}>“</span>}
          {entry.label.kind === "none" ? t("ai.chat.untitledTab", { defaultValue: "未命名" }) : entry.label.text}
        </span>
        {pinned && <Pin size={10} strokeWidth={1.6} fill="currentColor" className={styles.pinInline} aria-hidden />}
        <span className={`${styles.right} ${state === "waiting" && !(isOpen && entry.active) ? styles.rightAccent : ""}`}>
          {right}
        </span>
      </button>
      {/* Hover actions replace the right column; same three verbs as the right-click menu. */}
      <span className={styles.actions}>
        {onPin && (
          <button
            type="button"
            className={`${styles.action} ${pinned ? styles.actionOn : ""}`}
            onClick={onPin}
            title={t(pinned ? "ai.chat.unpinSession" : "ai.chat.pinSession", { defaultValue: pinned ? "取消固定" : "固定这次会话，不会被清掉" })}
            aria-pressed={pinned}
          >
            <Pin size={12} strokeWidth={1.6} fill={pinned ? "currentColor" : "none"} />
          </button>
        )}
        <button type="button" className={styles.action} onClick={onRename} title={t("ai.chat.rename", { defaultValue: "改名" })}>
          <Pencil size={12} strokeWidth={1.6} />
        </button>
        {onDelete && (
          <button
            type="button"
            className={styles.action}
            onClick={onDelete}
            disabled={busy}
            title={busy
              ? t("ai.chat.deleteBlockedRunning", { defaultValue: "正在生成 · 先停止" })
              : t("ai.chat.deleteSession", { defaultValue: "删除" })}
          >
            <Trash2 size={12} strokeWidth={1.6} />
          </button>
        )}
        {isOpen && !entry.active && (
          <button type="button" className={styles.switchTo} onClick={onGo}>
            {t("ai.chat.switchTo", { defaultValue: "切到 ›" })}
          </button>
        )}
      </span>
    </div>
  );
}

function RenameRow({ entry, initial, onCommit, onCancel }: {
  entry: Entry;
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const placeholder = entry.label.kind === "preview" ? `“${entry.label.text}` : t("ai.chat.renamePlaceholder", { defaultValue: "给这段对话起个名" });
  return (
    <div className={`${styles.row} ${styles.rowEditing}`}>
      <span className={styles.rowMark}><ChatMark state={entry.kind === "open" ? entry.state : null} /></span>
      <input
        ref={ref}
        className={styles.renameInput}
        value={value}
        maxLength={MAX_SESSION_TITLE_CHARS}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(value); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }}
      />
      <span className={`${styles.counter} ${value.length >= MAX_SESSION_TITLE_CHARS ? styles.counterFull : ""}`}>
        {value.length} / {MAX_SESSION_TITLE_CHARS}
      </span>
    </div>
  );
}

/** The right-hand mono column for an open row: what the mark means, in words. */
function statusText(
  t: (k: string, o?: Record<string, unknown>) => string,
  s: ReturnType<typeof useAgentStore.getState>,
  key: string,
  chat: LiveChat | undefined,
): string {
  const state = chatStateOf(s, key);
  const last = chat ? [...chat.turns].reverse().find((tn) => tn.role === "assistant") : null;
  const rounds = last ? roundsOf(last.log) : 0;
  switch (state) {
    case "running": return t("ai.chat.stateRunning", { n: rounds, defaultValue: `第 ${rounds} 轮` });
    case "queued": return t("ai.chat.stateQueued", { n: chatQueuePosition(s, key) + 1, defaultValue: `排队 · 第 ${chatQueuePosition(s, key) + 1}` });
    case "unread": return t("ai.chat.stateUnread", { n: rounds, defaultValue: `刚刚 · ${rounds} 轮` });
    case "error": return t("ai.chat.stateError", { defaultValue: "出错" });
    default: return chat && chat.turns.length === 0 ? "" : formatSessionTime((last?.at ?? Date.now()) / 1000);
  }
}

export function formatSessionTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
