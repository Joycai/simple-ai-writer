/**
 * What a conversation's tab (or list row, or the mode tab) says about it —
 * 设计稿 23 屏 1d, "三家记号": one accent colour, the family of the shape
 * decides how urgent it is.
 *
 *   圆 = 在跑      running (solid, pulsing) · queued (hollow ring)  — leave it
 *   方 = 有结果    unread (solid 7px) · error (hollow 7px)          — look when free
 *   两根竖条 = 停住等你   waiting                                    — go there
 *
 * Pure: the store hands in five booleans, this decides which one the author
 * sees. Two orderings, deliberately different:
 *
 * - {@link chatState} is *this* conversation's own state. A waiting card
 *   outranks its run (the run has stopped for it); a finished run's error
 *   outranks its "new reply" (the reply is the error).
 * - {@link mostUrgent} is the one mark the mode tab may carry for all of them:
 *   "有等作者就挂竖条；没有，有新回复或出错就挂方块；都没有、只在跑，挂脉动点".
 */

export type ChatState = "waiting" | "running" | "queued" | "error" | "unread";

export interface ChatStateInput {
  running: boolean;
  queued: boolean;
  /** A card (approval / plan / question / round cap / truncation) is blocking its run. */
  waiting: boolean;
  /** Finished, or failed, while the author was elsewhere. */
  unread: boolean;
  error: boolean;
}

export function chatState(i: ChatStateInput): ChatState | null {
  if (i.waiting) return "waiting";
  if (i.running) return "running";
  if (i.queued) return "queued";
  if (i.unread && i.error) return "error";
  if (i.unread) return "unread";
  return null;
}

/** Urgency for the one mark a summary (the mode tab) may show. */
const URGENCY: Record<ChatState, number> = {
  waiting: 5,
  error: 4,
  unread: 3,
  running: 2,
  queued: 1,
};

export function mostUrgent(states: readonly (ChatState | null)[]): ChatState | null {
  let best: ChatState | null = null;
  for (const s of states) {
    if (s && (!best || URGENCY[s] > URGENCY[best])) best = s;
  }
  return best;
}

/** Whether the mark belongs to the "look when free" family (方). */
export function isResultState(s: ChatState | null): boolean {
  return s === "unread" || s === "error";
}
