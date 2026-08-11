/**
 * Chat-history compaction — the impure half: run the summarize request and
 * swap the rebuilt history in. The planning/rebuild logic it drives is the
 * pure module next door (./compact); the caller (stores/agentStore.sendChat)
 * provides the provider plumbing and decides where the event lands.
 *
 * Failure semantics (docs/chat-memory-plan.md §4): compaction is best-effort.
 * A failed or empty summarize request returns null and leaves history *and*
 * meta untouched — the turn proceeds uncompacted and the threshold triggers
 * again next turn. Only an abort propagates, because it means the author
 * cancelled the whole send, not just this step. Compaction must never turn a
 * network hiccup into a damaged session.
 */

import i18n from "../../i18n";
import { streamCompletion } from "../ai";
import type { GeminiSafetySettings } from "../ai/safety";
import { estimateMessagesTokens } from "../ai/tokenEstimate";
import type { ApiStandard, AuthMode, StreamMessage } from "../ai/types";
import {
  buildCompactedHistory,
  injectionCarriers,
  planFold,
  renderTurnsForSummary,
  type ChatSessionMeta,
} from "./compact";
import type { AgentEvent } from "./events";

/** What the summarizer merges: the rolling summary so far + the folded turns. */
export interface SummarizeInput {
  prevSummary: string | null;
  rendered: string;
}

export interface CompactOutcome {
  /** The rebuilt history. A new array — the caller swaps it in. */
  history: StreamMessage[];
  /** The context-compacted event, for the current turn's execution log. */
  event: AgentEvent;
}

/**
 * Compact `history` if it is due, using `summarize` to fold the oldest turns
 * into the rolling summary. Returns null when nothing is due *or* when the
 * summarize step failed (see module doc); `meta` is only ever updated on the
 * success path, so a null return guarantees an untouched session.
 */
export async function compactChatHistory(opts: {
  history: StreamMessage[];
  meta: ChatSessionMeta;
  ceilingTokens: number;
  summarize: (input: SummarizeInput) => Promise<string>;
}): Promise<CompactOutcome | null> {
  const { history, meta } = opts;
  const plan = planFold(history, meta, opts.ceilingTokens);
  if (!plan) return null;

  const fromTokens = estimateMessagesTokens(history);
  let summaryText: string;
  try {
    summaryText = (
      await opts.summarize({
        prevSummary: meta.summaryText,
        // Injection carriers are skipped: retrieval blocks are reproducible
        // and would spend summarizer input on what the lore index already has.
        rendered: renderTurnsForSummary(plan.fold, injectionCarriers(meta)),
      })
    ).trim();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return null;
  }
  // A model that returned nothing has summarized nothing — folding the turns
  // anyway would trade context for a blank line.
  if (!summaryText) return null;

  const block = i18n.t("ai.instructions.chatCompactBlock", { summary: summaryText });
  const next = buildCompactedHistory(history, meta, plan, block);
  meta.summaryText = summaryText;
  return {
    history: next,
    event: {
      kind: "context-compacted",
      foldedTurns: plan.fold.length,
      fromTokens,
      toTokens: estimateMessagesTokens(next),
      summary: summaryText,
      at: Date.now(),
    },
  };
}

/** Provider plumbing for the summarize request — same fields sendChat holds. */
export interface SummarizeRequestConfig {
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  modelId: string;
  prefix?: string;
  contextSize?: number;
  /** Sent as `max_tokens` on the Anthropic path; planning-only elsewhere. */
  maxOutput?: number;
  safetySettings?: GeminiSafetySettings;
  /** Anthropic-compat auth scheme; ignored by every other protocol. */
  authMode?: AuthMode;
}

/**
 * The real summarizer: one no-tools completion on the session's own model.
 * Kept apart from {@link compactChatHistory} so tests (and any future
 * "dedicated summary model" setting) can swap it without touching the flow.
 */
export async function summarizeForCompaction(
  config: SummarizeRequestConfig,
  input: SummarizeInput,
  signal: AbortSignal,
): Promise<string> {
  const parts: string[] = [];
  if (input.prevSummary) {
    parts.push(`${i18n.t("ai.instructions.chatCompactExisting")}\n${input.prevSummary}`);
  }
  parts.push(`${i18n.t("ai.instructions.chatCompactFold")}\n${input.rendered}`);

  let text = "";
  await streamCompletion({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    standard: config.standard,
    modelId: config.modelId,
    prefix: config.prefix,
    contextSize: config.contextSize,
    maxOutput: config.maxOutput,
    safetySettings: config.safetySettings,
    authMode: config.authMode,
    messages: [
      { role: "system", content: i18n.t("ai.instructions.chatCompact") },
      { role: "user", content: parts.join("\n\n") },
    ],
    signal,
    onChunk: (chunk) => {
      if ("text" in chunk) text += chunk.text;
    },
  });
  return text;
}
