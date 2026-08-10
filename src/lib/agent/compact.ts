/**
 * Chat-history compaction — the pure bookkeeping and planning half of
 * docs/chat-memory-plan.md. This module segments the wire history into turns,
 * decides what to fold, renders folded turns for the summarizer, and rebuilds
 * the history around a summary. The impure half — actually running the
 * summarize request and wiring events — lives with the caller (agentStore).
 *
 * Two invariants everything here is built around:
 *
 * 1. **Turn boundaries are message identities, not indices.** The history is
 *    mutated in place by parties that don't know about turns:
 *    `repairToolCallPairing` *splices* stub replies in (indices shift), and
 *    `trimHistory` swaps `content` on existing objects (identity survives).
 *    Recording the user-question message objects themselves is immune to both.
 *
 * 2. **The fold unit is a whole turn.** A `role:"tool"` reply must follow the
 *    assistant message that called for it — both providers reject a history
 *    that splits a pair, and a broken history is permanent because it *is* the
 *    session. Folding user+assistant+tools together can never open a gap.
 */

import { estimateMessagesTokens, estimateTextTokens } from "../ai/tokenEstimate";
import type { StreamMessage } from "../ai/types";
import type { LoreEntity, LoreIndex } from "../lore/model";

// ── Budget constants (docs/chat-memory-plan.md §6) ──────────────────

/** Share of the input ceiling at which compaction triggers. */
export const COMPACT_TRIGGER = 0.7;
/**
 * Post-fold target share. The gap below COMPACT_TRIGGER is deliberately wide:
 * one multi-tool turn can grow by thousands of tokens, and a tight gap would
 * compact every turn — invalidating the prompt-cache prefix every time.
 */
export const RETAIN_TARGET = 0.45;
/** Turns always kept verbatim, however far over budget the history is. */
export const MIN_KEEP_TURNS = 2;
/** Soft cap for the rolling summary the compaction pass maintains. */
export const SUMMARY_BUDGET_TOKENS = 1000;
/** Per-tool-result clip when rendering folded turns for the summarizer. */
export const FOLD_RESULT_CLIP = 200;
/**
 * Per-message clip for user/assistant prose in the summarizer input. Generous —
 * the conversation itself is what the summary is *of* — but bounded, so one
 * pasted chapter doesn't dominate the summarize request.
 */
export const FOLD_TEXT_CLIP = 2000;

// ── Session bookkeeping ─────────────────────────────────────────────

/**
 * Per-session records the flat `chatHistory` array cannot carry itself.
 * Mutable alongside the history it describes; reset with it (`resetChat`).
 */
/** One lore entity's entry in the injection ledger. */
export interface InjectionRecord {
  /** Fingerprint of the entity as injected — {@link entityVersion}. */
  version: string;
  /**
   * The message that carried it into the conversation. When that message
   * leaves the history (its turn folded, or the seed block dropped), the
   * entry is evicted — mention the entity again and it re-injects.
   */
  carrier: StreamMessage;
}

export interface ChatSessionMeta {
  /** The seeded-context message (dropped at first compaction). Null once gone. */
  seedContext: StreamMessage | null;
  /** The rolling-summary message. Null until the first compaction writes one. */
  summary: StreamMessage | null;
  /**
   * The summary's bare text, without the 【历史摘要】 block header the wire
   * message carries. The next compaction feeds this back to the summarizer —
   * from the message content it would have to strip the header first.
   */
  summaryText: string | null;
  /** The user-question messages, in order — each one starts a turn. */
  turnStarts: StreamMessage[];
  /**
   * What lore is currently in the conversation *because we put it there*,
   * keyed by entity dirPath. What the model reads through its own tools is
   * deliberately not tracked: that is its working memory — folded is
   * forgotten, and it can always read again.
   */
  injected: Map<string, InjectionRecord>;
  /** Document the last injected window belongs to — a switch re-injects. */
  lastDocPath: string | null;
}

export function createSessionMeta(): ChatSessionMeta {
  return {
    seedContext: null,
    summary: null,
    summaryText: null,
    turnStarts: [],
    injected: new Map(),
    lastDocPath: null,
  };
}

/**
 * Content fingerprint of an entity, from the index alone (no file reads):
 * name/aliases/summary plus the facet metadata. An edit that touches any of
 * those re-injects the entity; a body-only edit that leaves the summary
 * untouched slips through — acceptable, the model can still read the file.
 */
export function entityVersion(entity: LoreEntity): string {
  return JSON.stringify([
    entity.name,
    entity.aliases,
    entity.summary,
    (entity.facets ?? []).map((f) => [f.file, f.title, f.keys, f.mode, f.priority, f.group]),
  ]);
}

/** Record entities carried into the conversation by `carrier`. */
export function recordInjections(
  meta: ChatSessionMeta,
  entities: LoreEntity[],
  carrier: StreamMessage,
): void {
  for (const e of entities) {
    meta.injected.set(e.dirPath, { version: entityVersion(e), carrier });
  }
}

/**
 * The dirs the per-turn retrieval should skip: ledger entries whose entity is
 * unchanged since injection. A changed entity is *not* excluded — it matches
 * again, re-injects, and its ledger entry is overwritten with the new version.
 */
export function excludeDirsFor(meta: ChatSessionMeta, loreIndex: LoreIndex): Set<string> {
  const out = new Set<string>();
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) {
      const rec = meta.injected.get(e.dirPath);
      if (rec && rec.version === entityVersion(e)) out.add(e.dirPath);
    }
  }
  return out;
}

/** The messages currently carrying injections — for the summary render skip. */
export function injectionCarriers(meta: ChatSessionMeta): Set<StreamMessage> {
  return new Set([...meta.injected.values()].map((r) => r.carrier));
}

/** Record `msg` as the start of a new turn. Call right before pushing it. */
export function noteTurnStart(meta: ChatSessionMeta, msg: StreamMessage): void {
  meta.turnStarts.push(msg);
}

// ── Segmentation ────────────────────────────────────────────────────

/** One turn: the question that opened it plus everything up to the next one. */
export interface WireTurn {
  start: StreamMessage;
  /** All of the turn's messages, `start` included. */
  messages: StreamMessage[];
}

export interface SegmentedHistory {
  /** Everything before the first turn: system, seed context, summary. */
  prelude: StreamMessage[];
  turns: WireTurn[];
}

/**
 * Split the history at the recorded turn starts. Membership is by object
 * identity; a recorded start no longer present (already folded) is simply not
 * a boundary. Repair stubs and image follow-ups spliced into a turn fall into
 * that turn, because they are not starts.
 */
export function segmentHistory(
  history: StreamMessage[],
  meta: ChatSessionMeta,
): SegmentedHistory {
  const starts = new Set(meta.turnStarts);
  const prelude: StreamMessage[] = [];
  const turns: WireTurn[] = [];
  let current: WireTurn | null = null;
  for (const msg of history) {
    if (starts.has(msg)) {
      current = { start: msg, messages: [msg] };
      turns.push(current);
    } else if (current) {
      current.messages.push(msg);
    } else {
      prelude.push(msg);
    }
  }
  return { prelude, turns };
}

// ── Fold planning ───────────────────────────────────────────────────

export interface FoldPlan {
  /** Oldest turns, to be summarized away. Never empty. */
  fold: WireTurn[];
  /** Newest turns, kept verbatim. */
  keep: WireTurn[];
  /** True when the seeded-context message is still present and gets dropped. */
  dropSeed: boolean;
  /** Estimated tokens of the rebuilt history (summary at its budget cap). */
  projectedTokens: number;
}

/**
 * Decide whether — and how much — to compact. Returns null while the history
 * is under the trigger, or when folding could not free anything (too few
 * turns). Folds oldest-first until the projection reaches the retain target,
 * always keeping the last {@link MIN_KEEP_TURNS} turns verbatim; when even the
 * maximum fold misses the target it still returns that best effort, because
 * freeing most of the room beats freeing none.
 */
export function planFold(
  history: StreamMessage[],
  meta: ChatSessionMeta,
  ceilingTokens: number,
): FoldPlan | null {
  if (ceilingTokens <= 0) return null;
  if (estimateMessagesTokens(history) <= ceilingTokens * COMPACT_TRIGGER) return null;

  const { prelude, turns } = segmentHistory(history, meta);
  const foldable = turns.length - MIN_KEEP_TURNS;
  if (foldable <= 0) return null;

  // The rebuilt history's fixed parts: the prelude minus the dropped seed
  // block, plus the summary at its worst-case (budget-cap) size. The old
  // summary is replaced, not joined, so its current size doesn't count.
  const dropSeed = meta.seedContext !== null;
  const keptPrelude = prelude.filter(
    (m) => m !== meta.seedContext && m !== meta.summary,
  );
  const target = ceilingTokens * RETAIN_TARGET;
  const baseTokens = estimateMessagesTokens(keptPrelude) + SUMMARY_BUDGET_TOKENS;

  let kept = baseTokens;
  for (const turn of turns.slice(foldable)) {
    kept += estimateMessagesTokens(turn.messages);
  }
  let foldCount = foldable;
  // Walk backwards from the largest fold: un-fold turns while there is room,
  // so the model keeps as much verbatim conversation as the target allows.
  while (foldCount > 1) {
    const candidate = estimateMessagesTokens(turns[foldCount - 1].messages);
    if (kept + candidate > target) break;
    kept += candidate;
    foldCount--;
  }

  return {
    fold: turns.slice(0, foldCount),
    keep: turns.slice(foldCount),
    dropSeed,
    projectedTokens: Math.round(kept),
  };
}

// ── Rendering for the summarizer ────────────────────────────────────

function clip(text: string, max: number): string {
  const collapsed = text.trim();
  return collapsed.length > max ? collapsed.slice(0, max) + "…" : collapsed;
}

/**
 * Flatten folded turns into the summarize request's input. Language-neutral
 * markers — the i18n'd summarize instruction (PR2) carries the language; this
 * is data. Tool traffic keeps only "what was asked, what came back, briefly":
 * the summary is *of the conversation*, not of the documents it read.
 *
 * `skip` — messages to leave out entirely, in practice the injection carriers
 * ({@link injectionCarriers}): retrieval blocks are reproducible data, and
 * summarizing them would spend the summary's budget on what the lore index
 * already knows.
 */
export function renderTurnsForSummary(
  turns: WireTurn[],
  skip?: ReadonlySet<StreamMessage>,
): string {
  const lines: string[] = [];
  for (const turn of turns) {
    for (const msg of turn.messages) {
      if (skip?.has(msg)) continue;
      if (msg.role === "tool") {
        lines.push(`[tool result] ${clip(msg.content, FOLD_RESULT_CLIP)}`);
      } else if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          lines.push(
            `[tool call] ${tc.function.name} ${clip(tc.function.arguments, FOLD_RESULT_CLIP)}`,
          );
        }
      } else if (typeof msg.content === "string") {
        lines.push(`[${msg.role}] ${clip(msg.content, FOLD_TEXT_CLIP)}`);
      } else if (Array.isArray(msg.content)) {
        // Image follow-ups: the text parts matter, the pixels don't summarize.
        const text = msg.content
          .map((p) => (p.type === "text" ? p.text : "[image]"))
          .join(" ");
        lines.push(`[${msg.role}] ${clip(text, FOLD_TEXT_CLIP)}`);
      }
    }
  }
  return lines.join("\n");
}

/** True when the summary's own size calls for folding it into itself (PR2). */
export function summaryOverBudget(summaryText: string): boolean {
  return estimateTextTokens(summaryText) > SUMMARY_BUDGET_TOKENS * 1.5;
}

// ── Rebuild ─────────────────────────────────────────────────────────

/**
 * Assemble the post-compaction history and update `meta` to describe it:
 * prelude (minus the dropped seed block), the summary message right after
 * system, then the kept turns verbatim. Returns a **new array** — the caller
 * swaps it in only after the summarize request succeeded, so a failed
 * compaction leaves the session exactly as it was (plan §4, atomicity).
 */
export function buildCompactedHistory(
  history: StreamMessage[],
  meta: ChatSessionMeta,
  plan: FoldPlan,
  summaryContent: string,
): StreamMessage[] {
  const { prelude } = segmentHistory(history, meta);
  const summaryMsg: StreamMessage = { role: "user", content: summaryContent };
  const next: StreamMessage[] = [];
  for (const msg of prelude) {
    if (msg === meta.seedContext || msg === meta.summary) continue;
    next.push(msg);
  }
  // Right after the prelude — in practice directly after system — so the
  // stable prefix stays maximal for prompt caching.
  next.push(summaryMsg);
  for (const turn of plan.keep) next.push(...turn.messages);

  meta.seedContext = null;
  meta.summary = summaryMsg;
  meta.turnStarts = plan.keep.map((t) => t.start);
  // Evict ledger entries whose carrier just left the history — those entities
  // are no longer in the conversation, so a later mention must re-inject.
  const live = new Set(next);
  for (const [dir, rec] of meta.injected) {
    if (!live.has(rec.carrier)) meta.injected.delete(dir);
  }
  return next;
}
