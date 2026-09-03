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
 * Illustrations do get their own, deliberately different thing: a **counted**
 * grant (`illustrateLeft`), made on an illustrate card for the next 1–5
 * pictures. Counted rather than boolean because each auto-approval spends
 * money — the author authorises an amount, not a mode — and it dies with the
 * run that created it, so a budget granted for "these five scene pictures"
 * cannot leak into next week's conversation.
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
  /** Manuscript proposals (edit/rewrite/append/create/move) apply without a card. */
  proposals: boolean;
  /** Lore plans are recorded without a card — the gate itself still applies. */
  plans: boolean;
  /**
   * Files the author authorised **appends to**, by absolute path.
   *
   * Narrower than `proposals` on both axes on purpose. Building one big
   * deliverable is a dozen `append_file` calls to the *same* file, and asking
   * a dozen times trains the author to click through without reading — but
   * "keep adding to this page" is not "keep changing my manuscript", and it is
   * certainly not "keep deleting". So the grant names one file and covers one
   * kind: everything else still asks.
   */
  appendPaths: string[];
  /**
   * How many more illustrate proposals apply without a card. A budget, not a
   * mode: each auto-approval decrements it, 0 means back to asking, and the
   * card's control caps it at {@link ILLUSTRATE_GRANT_MAX}.
   */
  illustrateLeft: number;
  /**
   * The run that created the illustrate budget. Unlike the boolean grants —
   * which chat keeps for the whole conversation — the budget is voided when
   * this run ends (agentStore.rejectAll), so leftover authorisation to spend
   * money never carries into a turn the author hasn't seen yet.
   */
  illustrateRun?: unknown;
}

/** Most pictures one press of 批准并连批 may cover. */
export const ILLUSTRATE_GRANT_MAX = 5;

/** What a grant can cover. One flag per card kind that offers the button. */
export type AutoApproveKind = "proposals" | "plans";

/** The key chat uses. A literal, since a conversation has no run object. */
export const CHAT_AUTO_APPROVE_KEY = "chat";

/** Proposal kinds a grant may cover — `delete` and `illustrate` never do. */
const AUTO_APPROVABLE: ReadonlySet<Proposal["kind"]> = new Set([
  "edit",
  "rewrite",
  "append",
  // Adds lines, changes none: the narrowest write in the app, and the one whose
  // pass shape (a document's structure, several cards' worth) is exactly what a
  // grant is for.
  "insert",
  "create",
  "move",
  // A deck is a deterministic re-rendering of a page the author already has:
  // it costs nothing, destroys nothing, and iterating on a slide layout means
  // exporting the same file repeatedly.
  "pptx",
  "copy",
  // A markdown copy of a file the author already has, beside it, numbered on
  // collision: like copy, the only question is "should this exist twice".
  "convert",
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

/**
 * Whether an illustrate proposal is covered by the counted grant.
 *
 * Same key rule as {@link grants}; the count itself is decremented by the
 * store at the moment of auto-approval, not here — this only answers.
 */
export function grantsIllustrate(state: AutoApproveState | null, key: unknown): boolean {
  if (!state || key === undefined) return false;
  return state.key === key && state.illustrateLeft > 0;
}

/**
 * Whether appends to `path` are covered by a standing per-file grant.
 *
 * Same key rule as {@link grants} — a grant belongs to the surface that made
 * it, and an absent key must never match.
 */
export function grantsAppend(
  state: AutoApproveState | null,
  key: unknown,
  path: string,
): boolean {
  if (!state || key === undefined) return false;
  return state.key === key && state.appendPaths.includes(path);
}

/** How the button and the indicator chip should word themselves. */
export function autoApproveScope(key: unknown): "session" | "run" {
  return key === CHAT_AUTO_APPROVE_KEY ? "session" : "run";
}
