/**
 * The mark a conversation wears — 设计稿 23 屏 1d, "三家记号".
 *
 * One accent colour; the shape's family says how urgent it is:
 *   圆 (running solid pulsing · queued hollow ring)   — it's working, leave it
 *   方 (unread solid 7px · error hollow 7px)          — there's a result, look when free
 *   两根竖条 (waiting)                                 — it stopped for you, go there
 *
 * The three that existed (pulsing dot / hollow ring / 7px square) keep their
 * exact sizes from the roleplay roster; the two new ones are the pause sign and
 * the hollow square. `size="mode"` is the mode-tab rendition: the bars shrink to
 * 7px so they sit at the 6px square's scale.
 */
import type { ChatState } from "../../lib/agent/chatState";
import styles from "./ChatMark.module.css";

export function ChatMark({ state, size = "tab", title }: {
  state: ChatState | null;
  size?: "tab" | "mode";
  title?: string;
}) {
  if (!state) return null;
  const cls = `${styles.mark} ${styles[state]} ${size === "mode" ? styles.mode : ""}`;
  if (state === "waiting") {
    return (
      <span className={cls} title={title} aria-hidden>
        <span /><span />
      </span>
    );
  }
  return <span className={cls} title={title} aria-hidden />;
}
