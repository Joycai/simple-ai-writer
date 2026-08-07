/**
 * Context budget planner — turns the model's declared context window into
 * per-layer char budgets for a single AI task.
 *
 * The window is spent in a fixed priority order:
 *   1. **Output reserve** — room for the model's reply. Never handed to a layer;
 *      without it a "full" prompt leaves nowhere to write.
 *   2. **Fixed costs** — system prompt, task text, outline/knowledge extras.
 *      Non-negotiable: they *are* the request.
 *   3. **Recent-window floor** — the verbatim text immediately before the anchor.
 *      Prose the model can actually quote outranks any summary of it, so this
 *      layer keeps its historical size before a recap layer gets anything.
 *   4. **Lore** (`【设定资料】`) — the author's explicit setting, honored as-is
 *      and only trimmed if the window physically can't hold it.
 *   5. **Leftover** — first *grows* the recent window (again: verbatim beats
 *      summary), then splits by weight between `【前情提要】` (this document's
 *      story memory) and `【全书前情】` (prior-chapter recaps), with reflow.
 *
 * Only steps 3–5 are plannable. A model with no declared `contextSize` has no
 * basis for any of this, so the planner falls back to the historical fixed
 * constants — behavior is unchanged for anyone who never filled the field in.
 *
 * Everything here is arithmetic on char counts, converted to tokens with a ratio
 * **measured from the project's own prose** rather than assumed — see
 * measureCharsPerToken() for why guessing a constant here is unsafe.
 */

import { estimateTextTokens } from "../ai/tokenEstimate";
import { MEMORY_BUDGET_CHARS } from "./memory";

/**
 * Fallback chars-per-token when there isn't enough text to measure. 1.0 is the
 * CJK worst case and therefore the safe direction: underestimating capacity
 * costs a little unused context, overestimating gets the request rejected.
 */
export const FALLBACK_CHARS_PER_TOKEN = 1;

/**
 * Chars per token for a body of text, measured with the *same* estimator the
 * pre-flight context check uses (lib/ai/tokenEstimate).
 *
 * This must not be a constant. The rest of the context layer assumes ~3 chars
 * per token, but the pre-flight check counts CJK at ~1 token per char — a 3×
 * disagreement. That was harmless while every budget was a small fixed constant;
 * once budgets scale to fill the window, planning with the optimistic ratio
 * builds a prompt the client then refuses to send. Measuring against the
 * authoritative estimator keeps the plan and the gate in agreement, and adapts
 * on its own to Chinese (~1) vs Latin-script (~4) manuscripts.
 */
export function measureCharsPerToken(sample: string): number {
  const text = sample.slice(-8_000);
  if (text.length < 200) return FALLBACK_CHARS_PER_TOKEN;
  const tokens = estimateTextTokens(text);
  if (tokens <= 0) return FALLBACK_CHARS_PER_TOKEN;
  return clamp(text.length / tokens, 1, 4);
}

/**
 * Share of the context window one request may occupy (input + reply).
 * Deliberately well under 1.0 by default: a window that *can* hold 1M tokens
 * still costs real money to fill on every keystroke-triggered task, and long
 * contexts measurably dilute instruction-following.
 */
export const CONTEXT_UTILIZATION_MIN = 0.1;
export const CONTEXT_UTILIZATION_MAX = 0.95;
export const CONTEXT_UTILIZATION_DEFAULT = 0.5;

/** Static fallback for 【全书前情】 when the model declares no context size. */
export const BOOK_PRIOR_BUDGET_CHARS = 5000;

/**
 * Default size of the verbatim recent-content window, and its floor once the
 * window is being planned dynamically. Owned here (rather than in rag.ts) so the
 * planner, the assembler and the UI all read the same number.
 */
export const RECENT_WINDOW_MIN_CHARS = 800 * 3;

/**
 * Ceiling on the lore block when the model declares **no** context size.
 *
 * Without a declared window there is no dynamic plan *and* no pre-flight check
 * (lib/ai/index.ts only gates when contextSize > 0), so nothing else downstream
 * would stop a 128k-token lore setting from building a prompt no endpoint will
 * accept. This is that missing gate — the historical LORE_BUDGET_MAX.
 */
export const STATIC_LORE_BUDGET_MAX_TOKENS = 2_000;

/**
 * Assumed input ceiling for a model that declares no context size.
 *
 * `Model.contextSize` is optional — a hand-added model routinely has none —
 * and the tool loop's `trimHistory` is a no-op without a ceiling. That was
 * survivable while tool results were text; it stopped being survivable once
 * `read_lore_image` began pushing base64 data URLs into a chat history that
 * persists across turns, with no degradation path but a provider 400 several
 * pictures in.
 *
 * Deliberately small: the point is to bound growth, and guessing low only
 * elides old tool results, whereas guessing high fails the request outright.
 */
export const ASSUMED_INPUT_CEILING_TOKENS = 32_000;

/**
 * The input ceiling to plan a tool loop against — the model's declared window
 * scaled by the author's utilization setting, or the assumed ceiling above.
 */
export function inputCeilingFor(contextSize: number | undefined, utilization: number): number {
  return contextSize && contextSize > 0
    ? Math.floor(contextSize * utilization)
    : ASSUMED_INPUT_CEILING_TOKENS;
}

/** Floor for the reply reserve, in tokens. */
const OUTPUT_RESERVE_MIN_TOKENS = 2_000;

/** Share of the leftover that grows the verbatim window before recaps are fed. */
const RECENT_WEIGHT = 0.5;

/** Leftover split: this document's own recent plot outranks the book-level recap. */
const MEMORY_WEIGHT = 0.6;
const BOOK_WEIGHT = 1 - MEMORY_WEIGHT;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Tokens held back for the model's answer. Scaled off the requested reply length
 * (×2, since the estimate is rough and models overshoot) with a hard floor —
 * tasks like polish/summary declare no length but still need room.
 */
export function outputReserveTokens(
  replyChars: number,
  charsPerToken: number,
  maxOutputTokens?: number,
): number {
  const ratio = charsPerToken > 0 ? charsPerToken : FALLBACK_CHARS_PER_TOKEN;
  const scaled = Math.ceil(Math.max(0, replyChars) / ratio) * 2;
  const reserve = Math.max(OUTPUT_RESERVE_MIN_TOKENS, scaled);
  // A model that physically cannot emit more than N tokens gains nothing from
  // holding back more than N — the surplus is window the prompt could have had.
  // The cap applies *after* the floor, so a 1k-output model reserves 1k.
  return maxOutputTokens && maxOutputTokens > 0 ? Math.min(reserve, maxOutputTokens) : reserve;
}

export interface ContextBudgetInput {
  /** Model context window in tokens. Undefined/0 → static fallback plan. */
  contextSize?: number;
  /**
   * Most tokens this model can emit in one reply, when known. Caps the output
   * reserve so the plan stops holding back window the model can't use.
   */
  maxOutputTokens?: number;
  /** Share of the window one request may use (see CONTEXT_UTILIZATION_*). */
  utilization: number;
  /** The author's 【设定资料】 setting, in tokens. */
  loreBudgetTokens: number;
  /** Chars the request spends before any planned layer — see fixedContextChars. */
  fixedChars: number;
  /** Whether this document has story memory to draw 【前情提要】 from. */
  hasMemory: boolean;
  /** Whether 【全书前情】 participates (continuation tasks only). */
  includeBookContext: boolean;
  /** Requested reply length in chars, when the task declares one. */
  replyChars?: number;
  /**
   * Verbatim-window size the task explicitly asked for (the 「参考上下文范围」
   * picker on polish/rewrite/summary, including an explicit 0). When present it
   * is an author decision and is honored exactly — never grown, never trimmed
   * except by a window that physically can't hold it. Omit for tasks with no
   * picker (continue/custom): the window then becomes a plannable layer that
   * grows with the model, floored at RECENT_WINDOW_MIN_CHARS.
   */
  recentWindowChars?: number;
  /**
   * How much text actually precedes the anchor. Caps the recent window's growth
   * so a short chapter doesn't reserve space it can never fill.
   */
  availableRecentChars?: number;
  /**
   * Chars per token for this manuscript, from measureCharsPerToken(). Governs
   * every token↔char conversion in the plan. Defaults to the CJK worst case.
   */
  charsPerToken?: number;
}

export interface ContextBudgetPlan {
  loreChars: number;
  memoryChars: number;
  bookPriorChars: number;
  /** Verbatim recent-content window this request should slice. */
  recentWindowChars: number;
  /** False when the model declared no context size and constants were used. */
  dynamic: boolean;
  /** Input-token ceiling this plan targeted (0 when static). */
  inputCeilingTokens: number;
  /** Tokens reserved for the reply (0 when static). */
  reservedOutputTokens: number;
  /** The ratio used for every conversion here — lets callers report in tokens. */
  charsPerToken: number;
}

export function planContextBudget(input: ContextBudgetInput): ContextBudgetPlan {
  const charsPerToken = input.charsPerToken && input.charsPerToken > 0
    ? input.charsPerToken
    : FALLBACK_CHARS_PER_TOKEN;
  // `?? ` not `||`: an explicit 0 means "send no recent context", not "unset".
  const explicitRecent = input.recentWindowChars;
  const recentFloor = Math.max(0, explicitRecent ?? RECENT_WINDOW_MIN_CHARS);

  if (!input.contextSize || input.contextSize <= 0) {
    // No declared window → no dynamic plan and no pre-flight gate downstream, so
    // the lore setting has to be capped here or nothing caps it at all.
    const staticLoreTokens = Math.min(
      Math.max(0, input.loreBudgetTokens),
      STATIC_LORE_BUDGET_MAX_TOKENS,
    );
    return {
      loreChars: Math.floor(staticLoreTokens * charsPerToken),
      memoryChars: MEMORY_BUDGET_CHARS,
      bookPriorChars: input.includeBookContext ? BOOK_PRIOR_BUDGET_CHARS : 0,
      recentWindowChars: recentFloor,
      dynamic: false,
      inputCeilingTokens: 0,
      reservedOutputTokens: 0,
      charsPerToken,
    };
  }

  const loreRequested = Math.floor(Math.max(0, input.loreBudgetTokens) * charsPerToken);
  const util = clamp(input.utilization, CONTEXT_UTILIZATION_MIN, CONTEXT_UTILIZATION_MAX);
  const reservedOutputTokens = outputReserveTokens(
    input.replyChars ?? 0,
    charsPerToken,
    input.maxOutputTokens,
  );
  const inputCeilingTokens = Math.max(
    0,
    Math.floor(input.contextSize * util) - reservedOutputTokens,
  );

  const ceilingChars = Math.floor(inputCeilingTokens * charsPerToken);
  const afterFixed = Math.max(0, ceilingChars - Math.max(0, input.fixedChars));

  // The verbatim window keeps its floor first: a summary of the last page is
  // never worth more than the page itself.
  let recentWindowChars = Math.min(recentFloor, afterFixed);
  let rest = afterFixed - recentWindowChars;

  // Lore is an explicit author decision, so it outranks the recap layers — but
  // it can't exceed what physically remains.
  const loreChars = Math.min(loreRequested, rest);
  rest -= loreChars;

  // Grow the verbatim window with half of what's left — but only when the task
  // has no explicit picker, and never past the text that actually exists.
  if (explicitRecent === undefined) {
    const room = Math.max(0, (input.availableRecentChars ?? Infinity) - recentWindowChars);
    const grow = Math.min(room, Math.floor(rest * RECENT_WEIGHT));
    recentWindowChars += grow;
    rest -= grow;
  }

  // A layer that cannot contribute yields its whole share up front. The other
  // direction — the book layer underspending its share — can only be known once
  // it's actually built, and reflows via reflowMemoryBudget().
  let memoryChars: number;
  let bookPriorChars: number;
  if (!input.includeBookContext) {
    memoryChars = rest;
    bookPriorChars = 0;
  } else if (!input.hasMemory) {
    memoryChars = 0;
    bookPriorChars = rest;
  } else {
    bookPriorChars = Math.floor(rest * BOOK_WEIGHT);
    memoryChars = rest - bookPriorChars;
  }

  return {
    loreChars,
    memoryChars,
    bookPriorChars,
    recentWindowChars,
    dynamic: true,
    inputCeilingTokens,
    reservedOutputTokens,
    charsPerToken,
  };
}

/**
 * Second half of the weighted split: hand 【全书前情】's unspent share back to
 * 【前情提要】. Short books rarely fill the book layer, and the current chapter's
 * own memory is the better use of that space.
 *
 * @param bookUsedChars Chars the book layer actually produced (0 if it was skipped).
 */
export function reflowMemoryBudget(plan: ContextBudgetPlan, bookUsedChars: number): number {
  if (!plan.dynamic) return plan.memoryChars;
  return plan.memoryChars + Math.max(0, plan.bookPriorChars - bookUsedChars);
}

/**
 * Final per-layer allocation for one run, for the AI panel's transparency line.
 *
 * All four numbers are "how much of the window this layer holds", but they are
 * not all measured at the same moment, and the difference is deliberate:
 * `bookPriorChars` is the size the 【全书前情】 layer *realized* (it is built
 * before the rest, and whatever it left over has already been reflowed into
 * `memoryChars`), while the other three are the final budgets handed to their
 * layers. Reporting the book layer's planned share instead would double-count
 * the reflowed remainder.
 */
export interface ContextAllocation {
  loreChars: number;
  memoryChars: number;
  bookPriorChars: number;
  recentWindowChars: number;
  charsPerToken: number;
  /** False when constants were used — the panel hides the line in that case. */
  dynamic: boolean;
}

/**
 * Sum the request's non-plannable cost, so the planner knows what's actually
 * left. Overestimating here is safe (layers just get less); underestimating
 * risks the pre-flight context check rejecting the request outright.
 *
 * The verbatim recent window is deliberately *not* here — it is a plannable
 * layer (see ContextBudgetInput.recentWindowChars).
 */
export function fixedContextChars(parts: {
  systemPromptChars: number;
  taskInstructionChars: number;
  selectionChars: number;
  outlineChars?: number;
  knowledgeChars?: number;
  /** Previous chapter's verbatim tail, when a continuation may include one. */
  prevChapterTailChars?: number;
}): number {
  return (
    parts.systemPromptChars +
    parts.taskInstructionChars +
    parts.selectionChars +
    (parts.outlineChars ?? 0) +
    (parts.knowledgeChars ?? 0) +
    (parts.prevChapterTailChars ?? 0)
  );
}
