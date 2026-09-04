/**
 * The drawer header's title in 对话助手 mode — the conversation's *name*, not the
 * product's (设计稿 23 屏 1f). 「对话助手」is already lit on the mode tab; writing
 * it twice said nothing, and the name is what the author reaches for when they
 * want to rename.
 *
 * Four states, all in place — a name is not worth a dialog:
 *   静止   the title in serif 20; no title → 未命名会话 on a dashed baseline (the
 *          chip language for "absent"), never the first question as a stand-in
 *   悬停   a pencil and「点击改名」appear
 *   编辑中 the same text becomes the input (1px sienna frame, same size, same
 *          place), with a mono n / 60 counter; ↵ saves, Esc cancels, an emptied
 *          field goes back to the first question
 *   60 字  the counter turns sienna and a line says 最多 60 字
 *
 * 「让助手起名」would live inside the field at its right end — it fills the
 * field, it does not save — and is deliberately not rendered yet (plan §3.4);
 * the slot is the `.suggest` gap the CSS keeps.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { useActiveChat, useAgentStore } from "../../stores/agentStore";
import { MAX_SESSION_TITLE_CHARS, normalizeSessionTitle } from "../../lib/agent/sessionDb";
import styles from "./SessionTitle.module.css";

export function SessionTitle() {
  const { t } = useTranslation();
  const key = useAgentStore((s) => s.activeChatKey);
  const title = useActiveChat((c) => c.title);
  const renameChat = useAgentStore((s) => s.renameChat);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  // A tab switch under an open editor: the editor was about the other one.
  useEffect(() => { setEditing(false); }, [key]);
  useEffect(() => {
    if (!editing) return;
    setDraft(title);
    const el = inputRef.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing, title]);

  const commit = () => {
    setEditing(false);
    const clean = normalizeSessionTitle(draft);
    if (clean !== title) void renameChat(clean, key);
  };
  const cancel = () => setEditing(false);

  if (editing) {
    const n = draft.length;
    const full = n >= MAX_SESSION_TITLE_CHARS;
    return (
      <div className={styles.editWrap}>
        <div className={`${styles.field} ${full ? styles.fieldFull : ""}`}>
          <input
            ref={inputRef}
            className={styles.input}
            value={draft}
            maxLength={MAX_SESSION_TITLE_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              else if (e.key === "Escape") { e.preventDefault(); cancel(); }
            }}
            placeholder={t("ai.chat.renamePlaceholder", { defaultValue: "给这段对话起个名" })}
            aria-label={t("ai.chat.rename", { defaultValue: "改名" })}
          />
          <span className={`${styles.counter} ${full ? styles.counterFull : ""}`}>
            {n} / {MAX_SESSION_TITLE_CHARS}
          </span>
          {/* .suggest — 「让助手起名」's reserved place (plan §3.4, not rendered). */}
        </div>
        <div className={styles.hint}>
          {full
            ? t("ai.chat.titleMax", { n: MAX_SESSION_TITLE_CHARS, defaultValue: `最多 ${MAX_SESSION_TITLE_CHARS} 字` })
            : t("ai.chat.renameHint", { defaultValue: "↵ 保存 · Esc 取消 · 清空 ＝ 回到第一句" })}
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={styles.title}
      onClick={() => setEditing(true)}
      title={t("ai.chat.clickToRename", { defaultValue: "点击改名" })}
    >
      {title
        ? <span className={styles.name}>{title}</span>
        : <span className={styles.untitled}>{t("ai.chat.untitledChat", { defaultValue: "未命名会话" })}</span>}
      <span className={styles.pencil} aria-hidden>
        <Pencil size={11} strokeWidth={1.8} />
        <span className={styles.pencilText}>{t("ai.chat.clickToRename", { defaultValue: "点击改名" })}</span>
      </span>
    </button>
  );
}
