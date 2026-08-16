/**
 * "Approve everything like this for now" — the memory an approval card keeps.
 *
 * Every L2 proposal and every lore plan blocks the tool loop on its own card
 * (see registry.ts → Proposal, plan.ts). That is right for one change and wrong
 * for twenty: a housekeeping pass over a chapter fires a dozen identical cards,
 * and the author clicks 批准 a dozen times without reading the last ten. So each
 * card offers to stand for the ones after it.
 *
 * Two things are deliberately NOT covered, no matter what the author turned on:
 *
 *   delete      — a chapter that is gone is gone. The card is the last look.
 *   illustrate  — approving it **spends money** (the card prints the price).
 *                 An authorisation the author gave for "keep fixing my prose"
 *                 must never quietly become one for "keep buying pictures".
 *
 * They are excluded here, in one list, rather than at each call site, so the
 * rule is checkable in one place — and the approval card simply doesn't render
 * the button for them, which needs no explaining to the author.
 *
 * Scope belongs to whoever owns the run, not to this module: chat means the
 * whole conversation, a task panel run means that run. Callers say which by the
 * key they pass (see agentStore.AutoApproveState).
 */

import type { Proposal } from "./registry";

/**
 * Which surface is currently auto-approving, and what for.
 *
 * `key` identifies the owner: the string `"chat"` for the conversation, or a
 * panel run's own AbortController (the same object the approval queues use as
 * their runId). A proposal auto-approves only when its binding carries the
 * *same* key — so a grant made inside a panel task cannot leak into chat, or
 * the other way round.
 *
 * There is exactly one slot, so only one surface auto-approves at a time; a
 * second grant displaces the first. Deliberate: the displaced surface falls
 * back to asking, and erring toward one more question is always the safe
 * direction.
 */
export interface AutoApproveState {
  key: unknown;
  /** Manuscript proposals (edit/rewrite/create/move) apply without a card. */
  proposals: boolean;
  /** Lore plans are recorded without a card — the gate itself still applies. */
  plans: boolean;
}

/** What a grant can cover. One flag per card kind that offers the button. */
export type AutoApproveKind = "proposals" | "plans";

/** The key chat uses. A literal, since a conversation has no run object. */
export const CHAT_AUTO_APPROVE_KEY = "chat";

/** Proposal kinds a grant may cover — `delete` and `illustrate` never do. */
const AUTO_APPROVABLE: ReadonlySet<Proposal["kind"]> = new Set([
  "edit",
  "rewrite",
  "create",
  "move",
]);

/** Whether this kind of proposal may skip its card under an active grant. */
export function isAutoApprovable(kind: Proposal["kind"]): boolean {
  return AUTO_APPROVABLE.has(kind);
}

/**
 * Whether a pending item's owner currently holds a grant of this kind.
 *
 * `key === undefined` means the surface never offered the button (no binding),
 * and must keep asking — an absent key must not match an absent state.
 */
export function grants(
  state: AutoApproveState | null,
  key: unknown,
  what: AutoApproveKind,
): boolean {
  if (!state || key === undefined) return false;
  return state.key === key && state[what];
}

/** How the button and the indicator chip should word themselves. */
export function autoApproveScope(key: unknown): "session" | "run" {
  return key === CHAT_AUTO_APPROVE_KEY ? "session" : "run";
}
