/**
 * agentStore's read side: pure functions of its state for components — which
 * conversation is on screen, each conversation's tab mark, queue position.
 * The two hooks that subscribe (`useActiveChat`, `useChatStateInputs`) stay in
 * `agentStore.ts`, since they need the store itself. Split out
 * (docs/feature/code-structure-plan.md P5); `agentStore` re-exports these.
 */

import { ownerBusy } from "../../lib/agent/scheduler";
import { chatState, mostUrgent, type ChatState } from "../../lib/agent/chatState";
import type { LiveChat, AgentState } from "./types";
import { chatSurface, emptyChat } from "./chatJob";


// ─── Read side for components ────────────────────────────────────────────────

const FALLBACK_CHAT: LiveChat = Object.freeze(emptyChat("")) as LiveChat;

/**
 * The conversation on screen. The invariant is that `activeChatKey` always
 * names an open one; the fallbacks are belt-and-braces so a render mid-update
 * never sees undefined.
 */
export function activeChat(s: AgentState): LiveChat {
  return s.chats[s.activeChatKey] ?? s.chats[s.chatOrder[0]] ?? FALLBACK_CHAT;
}


/**
 * The slices every per-conversation state helper below reads. A component that
 * derives an *array* over several conversations (the switch guard's rows, the
 * history menu's 已打开 section) must not build it inside a `useAgentStore`
 * selector: a selector returning a fresh array on every call never compares
 * equal, and under useSyncExternalStore that is an infinite render loop (React
 * #185, seen on first paint in the packaged app). Subscribe to these slices by
 * reference through `useChatStateInputs` and compute in `useMemo` instead.
 */
export type ChatStateInputs = Pick<
  AgentState,
  | "chats" | "chatOrder" | "activeChatKey" | "chatSessions"
  | "runningChats" | "compactingChats" | "chatQueue"
  | "pending" | "pendingPlans" | "pendingQuestions" | "pendingRoundLimits" | "pendingTruncations"
>;

export const pickChatStateInputs = (s: AgentState): ChatStateInputs => ({
  chats: s.chats, chatOrder: s.chatOrder, activeChatKey: s.activeChatKey, chatSessions: s.chatSessions,
  runningChats: s.runningChats, compactingChats: s.compactingChats, chatQueue: s.chatQueue,
  pending: s.pending, pendingPlans: s.pendingPlans, pendingQuestions: s.pendingQuestions,
  pendingRoundLimits: s.pendingRoundLimits, pendingTruncations: s.pendingTruncations,
});


/** Whether a card is blocking this conversation's run (any of the five kinds). */
function chatWaiting(s: ChatStateInputs, key: string): boolean {
  const surface = chatSurface(key);
  return s.pending.some((p) => p.surface === surface)
    || s.pendingPlans.some((p) => p.surface === surface)
    || s.pendingQuestions.some((p) => p.surface === surface)
    || s.pendingRoundLimits.some((p) => p.surface === surface)
    || s.pendingTruncations.some((p) => p.surface === surface);
}

/** When the oldest card blocking this conversation landed, or null. */
export function chatWaitingSince(s: ChatStateInputs, key: string): number | null {
  const surface = chatSurface(key);
  const ats = [
    ...s.pending, ...s.pendingPlans, ...s.pendingQuestions,
    ...s.pendingRoundLimits, ...s.pendingTruncations,
  ].filter((p) => p.surface === surface).map((p) => p.at);
  return ats.length ? Math.min(...ats) : null;
}

/** The one mark a conversation's tab wears (lib/agent/chatState). */
export function chatStateOf(s: ChatStateInputs, key: string): ChatState | null {
  const c = s.chats[key];
  if (!c) return null;
  return chatState({
    running: s.runningChats.includes(key),
    queued: s.chatQueue.some((j) => j.key === key),
    waiting: chatWaiting(s, key),
    unread: c.unread,
    error: c.error !== null,
  });
}

/** The one mark the mode tab wears for every conversation together. */
export function mostUrgentChatState(s: ChatStateInputs): ChatState | null {
  return mostUrgent(s.chatOrder.map((k) => chatStateOf(s, k)));
}

/** 0-based position in the queue, or -1. */
export const chatQueuePosition = (s: ChatStateInputs, key: string) =>
  s.chatQueue.findIndex((j) => j.key === key);

/** Generating, folding or waiting for a slot — no new exclusive work may start. */
export const isChatBusy = (s: ChatStateInputs, key: string) =>
  ownerBusy(key, s.runningChats, s.compactingChats, s.chatQueue);
