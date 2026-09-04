/**
 * What a conversation is *called* on a tab or a list row — 设计稿 23's "两种字":
 * the author's own title is set upright and bright; the first question stands
 * in for it in a dimmer weight, led by an opening quote mark that says "this is
 * what it said first, not its name"; a conversation with neither is 未命名, in
 * the faintest step and with no quote (it has no first sentence yet).
 *
 * Pure. The three-step fallback itself is sessionDb.sessionLabel; this adds the
 * *kind*, which is what the typography keys off.
 */

import { sessionPreview, type PersistedTurn } from "./chatSession";

export type ChatLabelKind = "title" | "preview" | "none";

export interface ChatLabel {
  text: string;
  kind: ChatLabelKind;
}

/** For a saved row: what sessionDb already computed. */
export function rowLabel(row: { title: string; preview: string }): ChatLabel {
  if (row.title) return { text: row.title, kind: "title" };
  if (row.preview) return { text: row.preview, kind: "preview" };
  return { text: "", kind: "none" };
}

/** For an open conversation: the preview is derived from its turns on the spot. */
export function liveLabel(chat: {
  title: string;
  turns: readonly { role: "user" | "assistant"; text: string }[];
}): ChatLabel {
  if (chat.title) return { text: chat.title, kind: "title" };
  // sessionPreview reads only role + text; the structural type here says so.
  const preview = sessionPreview(chat.turns as readonly PersistedTurn[]);
  if (preview) return { text: preview, kind: "preview" };
  return { text: "", kind: "none" };
}

/** `mm:ss` since `since`, for the 等你 counters. */
export function elapsedClock(since: number, now: number): string {
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** Tool rounds a finished (or running) assistant turn has used so far. */
export function roundsOf(log: readonly { kind: string }[]): number {
  return log.filter((e) => e.kind === "round-start").length;
}
