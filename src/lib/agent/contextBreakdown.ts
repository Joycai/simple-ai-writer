/**
 * What the chat session's context is currently made of — the data behind the
 * composer's context bar.
 *
 * The wire history is a flat array with no layer markers, but `ChatSessionMeta`
 * already records the identities that matter (lib/agent/compact.ts): which
 * message is the seeded context, which is the rolling summary, and which
 * messages carried lore into the conversation. Classifying by those identities
 * costs nothing extra and never drifts from what compaction actually does.
 *
 * Three things this is deliberate about, because the text meter it replaces got
 * all three wrong:
 *
 * 1. **The denominator is the input ceiling, not the model's window.** Both
 *    `compactChatHistory` and `runAgent` plan against `contextSize ×
 *    utilization` (lib/context/budget.ts → inputCeilingFor). Drawn against the
 *    raw window, compaction fires at 35% of the bar with nothing to explain it.
 * 2. **Tool schemas count — for the axis, but not for the trigger.** The
 *    pre-flight `ContextSizeError` gate weighs messages *plus* tool definitions,
 *    and the assistant preset's toolset runs to thousands of tokens on every
 *    round. Leave them out of the bar and a request can fail while it still
 *    looks roomy. But compaction is the other way round: `planFold` weighs
 *    messages alone against a ceiling the schemas have already been taken off
 *    (`messageCeilingFor`). So the schemas belong in `usedTokens`/`over` and
 *    belong *off both sides* of `willCompact`/`compactMarkerPct` — a bar that
 *    charges them once and draws its own 70% line as the trigger is describing
 *    a fold that happens somewhere else. (No number here on purpose — the
 *    toolset grows, and a count written into a comment only ever goes stale.
 *    `lib/agent/toolCost` measures it, and `agentToolBudget.test.ts` caps it.)
 * 3. **It reads the history, not the last event.** `round-start.estInputTokens`
 *    is a snapshot from mid-turn: zero on a fresh session, and between turns it
 *    describes the previous turn's last round rather than the history that has
 *    since gained a summary and this turn's injection block.
 */

import { estimateMessagesTokens } from "../ai/tokenEstimate";
import type { StreamMessage } from "../ai/types";
import { COMPACT_TRIGGER, injectionCarriers, type ChatSessionMeta } from "./compact";

/**
 * Bar segments, in wire order. `system` folds the tool schemas in with the
 * system message: neither is recoverable by compaction, and splitting a fixed
 * cost in two says nothing the author can act on.
 */
export type ContextSegmentKey =
  | "system"
  | "summary"
  | "seed"
  | "injected"
  | "conversation"
  | "free";

/** Ordered once here so the bar, the legend and the tooltips can't disagree. */
export const CONTEXT_SEGMENT_ORDER: readonly ContextSegmentKey[] = [
  "system",
  "summary",
  "seed",
  "injected",
  "conversation",
  "free",
];

export interface ContextBreakdown {
  segments: { key: ContextSegmentKey; tokens: number }[];
  /** Estimated input tokens the next request will carry. */
  usedTokens: number;
  /** The ceiling `used` is measured against — the planner's, not the window's. */
  ceilingTokens: number;
  /** The model's declared window, for context. 0 when it declares none. */
  contextSize: number;
  /** Where compaction triggers, as a percentage of the bar's full width. */
  compactMarkerPct: number;
  /**
   * True once the estimate has crossed the compaction trigger — the threshold
   * mark the bar draws. This is what the warning visuals key on: warning only
   * at 100% meant the bar could stand well past its own line while looking
   * perfectly calm.
   *
   * **Measured the way `planFold` measures**, which is not simply
   * `COMPACT_TRIGGER` of this bar's own width: compaction weighs the *messages*
   * against the *messages'* ceiling, and the tool schemas are off both sides of
   * that comparison (lib/agent/toolCost). See {@link computeContextBreakdown}.
   */
  willCompact: boolean;
  /**
   * True once the estimate has outgrown the ceiling — the bar has no free room
   * and the scale becomes `used`. Implies `willCompact`; kept separate because
   * it drives geometry (span packing), not the warning state.
   */
  over: boolean;
}

/**
 * Classify every message in `history` and total each bucket.
 *
 * Summing single-message estimates rather than calling
 * `estimateMessagesTokens(history)` once keeps the parts adding up to exactly
 * the whole, per-message overhead included — the bar would otherwise show a
 * remainder that belongs to no layer.
 */
export function computeContextBreakdown(
  history: StreamMessage[] | null,
  meta: ChatSessionMeta | null,
  toolTokens: number,
  ceilingTokens: number,
  contextSize: number,
): ContextBreakdown {
  const totals: Record<Exclude<ContextSegmentKey, "free">, number> = {
    // A session that hasn't run yet still pays for the tool schemas the moment
    // it does, so this is the honest starting state rather than an empty bar.
    system: toolTokens,
    summary: 0,
    seed: 0,
    injected: 0,
    conversation: 0,
  };

  // Entities injected by the seed block are carried *by* that block; without
  // this the seed's tokens would land in both buckets.
  const carriers = meta ? injectionCarriers(meta) : new Set<StreamMessage>();

  for (const msg of history ?? []) {
    const tokens = estimateMessagesTokens([msg]);
    if (msg.role === "system") totals.system += tokens;
    else if (meta && msg === meta.summary) totals.summary += tokens;
    else if (meta && msg === meta.seedContext) totals.seed += tokens;
    else if (carriers.has(msg)) totals.injected += tokens;
    else totals.conversation += tokens;
  }

  const usedTokens =
    totals.system + totals.summary + totals.seed + totals.injected + totals.conversation;
  const ceiling = Math.max(0, ceilingTokens);
  const free = Math.max(0, ceiling - usedTokens);
  // Past the ceiling the bar packs full and the scale becomes `used`, so the
  // trigger mark slides left instead of pinning to a bar it's already behind.
  const span = Math.max(usedTokens + free, 1);

  // Where compaction *actually* fires, expressed on this bar's axis.
  //
  // `planFold` compares the **messages** against the **messages' ceiling**, and
  // the tool schemas are off both sides of that comparison (`messageCeilingFor`
  // in lib/agent/toolCost subtracts them; `estimateMessagesTokens` never counted
  // them). This bar's axis is the whole request, schemas included. So the
  // trigger is not `COMPACT_TRIGGER` of the bar — it is `COMPACT_TRIGGER` of the
  // part of the bar that lies *after* the schemas:
  //
  //     compactAt = T + τ·(C − T)      instead of   τ·C
  //
  // Drawn the naive way the mark sat at a flat 70% while the real trigger was at
  // 70 + 30·T/C percent — on a 1M window a rounding error, on an 8k local model
  // fifteen points of bar. Both the line and the warning were early, so the bar
  // would go yellow and cross its own "past here the oldest turns get folded"
  // mark with nothing happening. `planFold`'s own `ceilingTokens` comment
  // records the first half of that symptom; this is the other side of it.
  const messageTokens = Math.max(0, usedTokens - toolTokens);
  const messageCeiling = Math.max(0, ceiling - toolTokens);
  const compactAtTokens = toolTokens + messageCeiling * COMPACT_TRIGGER;
  // Schemas alone at or over the ceiling: `planFold` bails on a non-positive
  // ceiling, so compaction cannot fire however long the conversation gets. The
  // `over` disjunct keeps `over ⇒ willCompact` true in that corner — everything
  // else the bar says is already wrong there, and a calm bar past its ceiling is
  // the exact state the warning exists to prevent.
  const over = usedTokens > ceiling;
  const willCompact =
    over || (messageCeiling > 0 && messageTokens > messageCeiling * COMPACT_TRIGGER);

  return {
    segments: [
      { key: "system", tokens: totals.system },
      { key: "summary", tokens: totals.summary },
      { key: "seed", tokens: totals.seed },
      { key: "injected", tokens: totals.injected },
      { key: "conversation", tokens: totals.conversation },
      { key: "free", tokens: free },
    ],
    usedTokens,
    ceilingTokens: ceiling,
    contextSize,
    compactMarkerPct: Math.min(100, (compactAtTokens * 100) / span),
    willCompact,
    over,
  };
}
