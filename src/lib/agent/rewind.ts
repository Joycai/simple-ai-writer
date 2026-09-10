/**
 * Chat rewind — 「回到这里重说」 for the conversational assistant, the pure half
 * (docs/feature/agent/chat-memory-plan.md §12). The store applies what this
 * module decides; the transcript's rewind buttons ask it which turns qualify.
 *
 * The roleplay panel has the same feature (roleplayStore.rewind), and it gets
 * away with throwing the whole wire history away: its transcript is the truth
 * and the next send re-seeds from it. The chat has no such source — the wire
 * history **is** the conversation (tool calls, results, injected lore, the
 * folded summary), and the display turns are a rendering of it. So a chat
 * rewind is a *cut*, not a re-seed: the history is truncated at the question
 * message that opened the target turn, and the meta that describes the history
 * (turn starts, the injection ledger, the document ledger) is brought back in
 * step, the way `buildCompactedHistory` does after a fold.
 *
 * One invariant decides which turns can be rewound to: **everything the author
 * still sees above the cut must still be in the wire.** A turn that has been
 * folded into the summary is not — its text survives only as prose inside the
 * summary, and prose cannot be truncated at a turn boundary (the same reason
 * the roleplay rewind deletes summary.md outright). Rewinding to a folded turn
 * would therefore leave the author looking at turns 1–4 while the model has
 * forgotten them, and those two views disagreeing is exactly the failure this
 * feature must not produce. Such turns are simply not offered. The first turn
 * is the one exception in the other direction: nothing is visible above it, so
 * rewinding there means starting the session over — the history goes back to
 * null and the next send re-seeds against the *new* first question.
 */

import type { StreamMessage } from "../ai/types";
import { pruneLedger, type ChatSessionMeta } from "./compact";

/** The slice of a display turn this module reads (agentStore's ChatTurn). */
export interface RewindableTurn {
  id: string;
  role: "user" | "assistant";
}

export type RewindPlan<T extends RewindableTurn> =
  /**
   * The target is the first question: nothing stays. The caller drops the
   * history and meta so the next send seeds a fresh context.
   */
  | { kind: "reseed"; turns: T[] }
  /**
   * Cut the history before `cutAt` (the index of the target's question
   * message) and keep the display turns before the target.
   */
  | { kind: "cut"; turns: T[]; cutAt: number };

/**
 * How many of the display's questions no longer open a wire turn — folded
 * into the summary (or, for a restored session with a damaged blob, dropped
 * on the way in; over-counting only withholds a button, never offers a wrong
 * one). Turn starts are recorded once per send and pruned only by folding,
 * so the newest `turnStarts.length` questions are the ones still verbatim.
 */
function foldedQuestionCount(userCount: number, meta: ChatSessionMeta | null): number {
  if (!meta) return userCount;
  return Math.max(0, userCount - meta.turnStarts.length);
}

/**
 * Ids of the user turns the author may rewind to: the first one (always — it
 * re-seeds), and every one whose question is still verbatim in the wire.
 * Assistant turns never qualify; a rewind is addressed to something the
 * author said.
 */
export function rewindableTurnIds(
  turns: readonly RewindableTurn[],
  meta: ChatSessionMeta | null,
): Set<string> {
  const users = turns.filter((t) => t.role === "user");
  const folded = foldedQuestionCount(users.length, meta);
  const out = new Set<string>();
  users.forEach((t, k) => {
    if (k === 0 || k >= folded) out.add(t.id);
  });
  return out;
}

/**
 * Decide the rewind for one turn id, or null when it cannot be done: an
 * unknown or assistant id, a folded question, or a recorded start the history
 * no longer holds (which would mean the meta and history disagree — refusing
 * is the only honest answer there).
 */
export function planRewind<T extends RewindableTurn>(
  turns: readonly T[],
  history: StreamMessage[] | null,
  meta: ChatSessionMeta | null,
  turnId: string,
): RewindPlan<T> | null {
  const at = turns.findIndex((t) => t.id === turnId);
  if (at < 0 || turns[at].role !== "user") return null;
  const kept = turns.slice(0, at);
  const k = kept.filter((t) => t.role === "user").length;
  if (k === 0) return { kind: "reseed", turns: [] };
  if (!history || !meta) return null;
  const users = turns.filter((t) => t.role === "user").length;
  const folded = foldedQuestionCount(users, meta);
  if (k < folded) return null;
  const start = meta.turnStarts[k - folded];
  const cutAt = start ? history.indexOf(start) : -1;
  if (cutAt < 0) return null;
  return { kind: "cut", turns: kept, cutAt };
}

/**
 * Apply a `cut` plan: returns the truncated history (a **new array**, like
 * `buildCompactedHistory`) and brings `meta` in step with it, in place.
 *
 * - Turn starts at or after the cut are gone with their turns.
 * - Ledger entries whose carrier left the history are evicted, per layer —
 *   the same rule a fold applies. An injection message pushed just *before*
 *   the target's question (per-turn injection lands ahead of the question it
 *   serves) sits below the cut and is deliberately **kept**: it is material the
 *   model has, the ledger says so, and the re-asked question will follow it
 *   exactly as the original did. Dropping it would mean guessing which
 *   trailing user message is an injection and which is an image follow-up
 *   from the turn before.
 * - The document ledger is reset. A file switch or a body window carried by
 *   one of the removed messages would otherwise stay on the books, and the
 *   model would never be told about a document it no longer knows. The cost
 *   is one repeated brief on the next turn; the alternative is an answer
 *   about the wrong file.
 * - The summary, the execution state and the seed block are untouched: they
 *   sit in the prelude, before every turn start, so a cut can never reach
 *   them — and everything they describe happened before the kept turns.
 */
export function applyRewindCut(
  history: StreamMessage[],
  meta: ChatSessionMeta,
  cutAt: number,
): StreamMessage[] {
  const next = history.slice(0, cutAt);
  const live = new Set(next);
  meta.turnStarts = meta.turnStarts.filter((m) => live.has(m));
  pruneLedger(meta, (carrier) => live.has(carrier));
  meta.lastDocPath = null;
  meta.bodyDocPath = null;
  return next;
}
