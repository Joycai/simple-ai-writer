/**
 * Chat-history compaction — the pure bookkeeping and planning half of
 * docs/feature/agent/chat-memory-plan.md. This module segments the wire history into turns,
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
import { facetKey, type LoreActivationReport } from "../context/loreSelect";
import type { SkillState } from "./skillState";

// ── Budget constants (docs/feature/agent/chat-memory-plan.md §6) ──────────────────

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

// ── Author-set trigger (docs/feature/agent/compact-threshold-plan.md §B.0) ────

/**
 * `assumed` is the ceiling line on a model that declares no window: the
 * settings readout says "受假定输入上限限制" rather than naming a 窗口占用 the
 * author cannot meaningfully raise.
 */
export type CompactTriggerBound = "tokens" | "ratio" | "ceiling" | "assumed";

export interface CompactTrigger {
  /** Message tokens at which the automatic fold fires. */
  tokens: number;
  /** Which of the three lines is the lowest — what the settings readout names. */
  boundBy: CompactTriggerBound;
}

/**
 * Where automatic compaction fires: the **lowest of three lines**.
 *
 *   tokens   — the absolute slider (8k–512k)
 *   ratio    — the window-ratio slider (50–80%) × the model's declared window
 *   ceiling  — the classic line, `COMPACT_TRIGGER × messageCeiling`
 *
 * The ceiling line stays in the set, and it is the one the sliders can never
 * beat upward: it is the last safe distance before `trimHistory` starts
 * eliding tool results, and a fold that fires above it would never get to
 * fire at all. So the sliders only ever pull the line *earlier*; at their
 * defaults (top of both ranges) the answer is the ceiling line, i.e. exactly
 * the behaviour before they existed.
 *
 * With the default 窗口占用 of 50% the ceiling line sits near 35% of the
 * window, so the ratio slider's whole 50–80% range loses to it — the settings
 * pane's readout exists to say which line won, and that one names 窗口占用.
 *
 * `ratio` needs a declared window; without one only `tokens` and `ceiling`
 * compete (the ceiling then being the assumed one, see lib/context/budget).
 * Ties go to the ceiling, then to ratio — a line that merely equals the
 * classic one has not changed anything worth naming.
 */
export function compactTriggerFor(input: {
  contextSize?: number;
  messageCeiling: number;
  triggerTokens: number;
  triggerRatio: number;
}): CompactTrigger {
  const window = input.contextSize ?? 0;
  const hasWindow = window > 0;
  let tokens = Math.max(0, Math.floor(input.messageCeiling * COMPACT_TRIGGER));
  let boundBy: CompactTriggerBound = hasWindow ? "ceiling" : "assumed";
  if (hasWindow) {
    const ratioLine = Math.floor(window * input.triggerRatio);
    if (ratioLine < tokens) { tokens = ratioLine; boundBy = "ratio"; }
  }
  const tokenLine = Math.floor(input.triggerTokens);
  if (tokenLine < tokens) { tokens = tokenLine; boundBy = "tokens"; }
  return { tokens: Math.max(0, tokens), boundBy };
}

/**
 * Where a fold stops, given where it fired. Keeps the classic 0.70 → 0.45 gap
 * as a *ratio* of the trigger rather than a share of the ceiling: with the
 * trigger pulled down to 16k on a 100k ceiling, a fixed 45k target would sit
 * above the trigger and the history would fold on every single turn.
 */
export function retainTargetFor(triggerTokens: number): number {
  return triggerTokens * (RETAIN_TARGET / COMPACT_TRIGGER);
}

// ── Session bookkeeping ─────────────────────────────────────────────

/**
 * Per-session records the flat `chatHistory` array cannot carry itself.
 * Mutable alongside the history it describes; reset with it (`resetChat`).
 */
/**
 * One lore entity's entry in the injection ledger.
 *
 * Kept per **layer**, not per entity, because the two halves arrive separately
 * and leave separately: an entity's body can sit in a permanent block (a
 * roleplay agent's bound settings) while its facets keep arriving on ordinary
 * turns that will one day be folded. One shared carrier could only be right for
 * one of them — and the wrong half then either re-injects while it is still on
 * screen, or stays suppressed after it is gone.
 */
export interface InjectionRecord {
  /** Fingerprint of the entity as injected — {@link entityVersion}. */
  version: string;
  /**
   * The message that carried the summary + body. Null when only facets have
   * gone in. When that message leaves the history (its turn folded, or the seed
   * block dropped), this drops to null — mention the entity again and the body
   * re-injects.
   */
  coreCarrier: StreamMessage | null;
  /** Facet file → the message that carried that facet's text. Same eviction. */
  facetCarriers: Map<string, StreamMessage>;
}

/** Which layers of one entity a carrier brought in. */
export interface InjectedLayers {
  /** The entity's **body** went in. A summary-only injection is not core. */
  core?: boolean;
  /** Facet filenames whose text went in. */
  facets?: readonly string[];
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
  /**
   * Document the conversation has been *told about* — by brief or by body. A
   * switch to another file sends at least its brief (lib/context/docFocus).
   */
  lastDocPath: string | null;
  /**
   * Document whose text is actually in the context, as opposed to merely
   * named. Null while only the brief was sent, which is the default: a later
   * turn that does point at the manuscript (「把这一段…」) injects the window
   * then, and this is how it knows it hasn't already.
   *
   * Like the lore ledger, it is not revised when compaction folds the message
   * that carried the window away — the model can read the file again, and
   * re-injecting on every turn after a compaction would be worse than the
   * occasional extra read.
   */
  bodyDocPath: string | null;
  /**
   * Which tier's briefing history[0] currently carries. The system layer is
   * seeded once per session (read-once, like the rosters) — but the briefing
   * is the one part that must not lie about the toolset: the orchestrator's
   * mandates every write go through `run_pack`, which routing removes the
   * moment the Beta goes off. So a mid-session tier flip rewrites history[0]
   * in place (agentStore.sendChat), and this field is how it knows the seeded
   * tier without parsing the prompt back out of the message.
   */
  briefingTier: "assist" | "orchestrator";
  /**
   * 状态记忆（SKILL.state 模式，lib/agent/skillState）开着没有。**会话的**属性
   * 而不是芯片的临时状态：历史的形状（每轮折叠、只留上一轮）取决于它，所以它
   * 随会话落盘、随会话恢复——不像 planMode 那样切换会话就归零。
   */
  stateMode: boolean;
  /**
   * 当前的执行状态 Σ——`summary` 那条消息在状态模式下装的就是它的渲染。null =
   * 还没折叠过、或最近一次折叠是普通归纳（那时 `summaryText` 是散文）。两种
   * 模式互相接得上：状态模式接手一段散文摘要时把它当输入，普通归纳接手一份
   * 状态时把 `summaryText`（状态的 JSON）当【已有摘要】。
   */
  state: SkillState | null;
}

export function createSessionMeta(): ChatSessionMeta {
  return {
    seedContext: null,
    summary: null,
    summaryText: null,
    turnStarts: [],
    injected: new Map(),
    lastDocPath: null,
    bodyDocPath: null,
    briefingTier: "assist",
    stateMode: false,
    state: null,
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

/**
 * Record what `carrier` brought in for one entity — **merging** with what is
 * already on the books rather than replacing it.
 *
 * Merging is the whole point: the body may have arrived in a permanent block on
 * turn 1 and a facet on an ordinary turn 5. Overwriting would leave the body's
 * ledger entry pointing at turn 5's message, and folding that turn would
 * re-inject a body that never left.
 *
 * An entity whose fingerprint changed is a different entity as far as the
 * ledger is concerned: the old layers describe text the author has since
 * rewritten, so the record starts over.
 */
export function recordInjection(
  meta: ChatSessionMeta,
  entity: LoreEntity,
  carrier: StreamMessage,
  layers: InjectedLayers,
): void {
  const version = entityVersion(entity);
  const prev = meta.injected.get(entity.dirPath);
  const rec: InjectionRecord = prev && prev.version === version
    ? prev
    : { version, coreCarrier: null, facetCarriers: new Map() };
  if (layers.core) rec.coreCarrier = carrier;
  for (const file of layers.facets ?? []) rec.facetCarriers.set(file, carrier);
  if (rec.coreCarrier || rec.facetCarriers.size > 0) meta.injected.set(entity.dirPath, rec);
}

/** Record whole entities carried in by `carrier` — body and nothing itemised. */
export function recordInjections(
  meta: ChatSessionMeta,
  entities: LoreEntity[],
  carrier: StreamMessage,
): void {
  for (const e of entities) recordInjection(meta, e, carrier, { core: true });
}

/**
 * Record a selection from its own activation report, so what goes on the books
 * is what {@link selectLore} actually emitted — layer by layer, per entity.
 *
 * `core` follows the **body**, not the summary line: the L0 summary is a floor
 * that survives even an exhausted budget, and treating it as "this entity is
 * delivered" would mean the body it lost to budget never arrives at all.
 */
export function recordInjectionsFromReport(
  meta: ChatSessionMeta,
  report: LoreActivationReport,
  loreIndex: LoreIndex,
  carrier: StreamMessage,
): void {
  const byDir = new Map<string, LoreEntity>();
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) byDir.set(e.dirPath, e);
  }
  for (const r of report.entities) {
    const entity = byDir.get(r.dirPath);
    if (!entity) continue;
    const core = r.layers.some((l) => l.kind === "core");
    const facets = r.layers.flatMap((l) => (l.kind === "facet" && l.file ? [l.file] : []));
    if (!core && facets.length === 0) continue;
    recordInjection(meta, entity, carrier, { core, facets });
  }
}

/** A ledger record that still describes the entity as the author has it now. */
function liveRecord(meta: ChatSessionMeta, entity: LoreEntity): InjectionRecord | null {
  const rec = meta.injected.get(entity.dirPath);
  return rec && rec.version === entityVersion(entity) ? rec : null;
}

/**
 * Entities whose **body** is already in the conversation — `selectLore`'s
 * `coreDone`. They still match and still contribute facets; they just do not
 * repeat what the model has already read. An entity the author has edited
 * since is absent, so the rewritten body goes in again.
 */
export function coreDoneFor(meta: ChatSessionMeta, loreIndex: LoreIndex): Set<string> {
  const out = new Set<string>();
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) {
      if (liveRecord(meta, e)?.coreCarrier) out.add(e.dirPath);
    }
  }
  return out;
}

/** Facets already in the conversation — `selectLore`'s `excludeFacets`. */
export function injectedFacetsFor(meta: ChatSessionMeta, loreIndex: LoreIndex): Set<string> {
  const out = new Set<string>();
  for (const entities of Object.values(loreIndex)) {
    for (const e of entities ?? []) {
      const rec = liveRecord(meta, e);
      if (!rec) continue;
      for (const file of rec.facetCarriers.keys()) out.add(facetKey(e.dirPath, file));
    }
  }
  return out;
}

/**
 * Dirs to skip **entirely** — the memory-area pass, which injects an area entry
 * as one unit and has no facet-level story to tell.
 *
 * Today it computes the same set as {@link coreDoneFor}, and that is not an
 * accident worth collapsing: the two answer different questions ("was this
 * entry delivered?" versus "may I skip this entity's body?"), and the area pass
 * must not silently inherit a facet rule written for the knowledge base.
 */
export function excludeDirsFor(meta: ChatSessionMeta, loreIndex: LoreIndex): Set<string> {
  return coreDoneFor(meta, loreIndex);
}

/**
 * Drop every ledger entry whose carrier `keep` rejects, and forget any entity
 * left holding nothing. Both callers are "these messages are gone": compaction
 * folding turns away, a block being rebuilt from scratch, and a rewind cutting
 * the history short (lib/agent/rewind).
 */
export function pruneLedger(meta: ChatSessionMeta, keep: (carrier: StreamMessage) => boolean): void {
  for (const [dir, rec] of meta.injected) {
    if (rec.coreCarrier && !keep(rec.coreCarrier)) rec.coreCarrier = null;
    for (const [file, carrier] of rec.facetCarriers) {
      if (!keep(carrier)) rec.facetCarriers.delete(file);
    }
    if (!rec.coreCarrier && rec.facetCarriers.size === 0) meta.injected.delete(dir);
  }
}

/**
 * Forget everything one message carried — for a permanent block that is being
 * rewritten. Without this, unbinding a facet would leave it on the books
 * forever: absent from the rebuilt block, yet still suppressed in retrieval.
 */
export function clearCarrier(meta: ChatSessionMeta, carrier: StreamMessage): void {
  pruneLedger(meta, (c) => c !== carrier);
}

/** The messages currently carrying injections — for the summary render skip. */
export function injectionCarriers(meta: ChatSessionMeta): Set<StreamMessage> {
  const out = new Set<StreamMessage>();
  for (const rec of meta.injected.values()) {
    if (rec.coreCarrier) out.add(rec.coreCarrier);
    for (const carrier of rec.facetCarriers.values()) out.add(carrier);
  }
  return out;
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
 *
 * `force` is the author's "compact now" button: the trigger check is skipped
 * (they asked, however full the bar is) and the fold is maximal — everything
 * but the last {@link MIN_KEEP_TURNS} turns. The walk-back that normally
 * un-folds turns while there is room exists to keep verbatim conversation the
 * budget doesn't need reclaimed yet; an explicit request is precisely the
 * statement that the author wants the room more than the verbatim turns.
 */
export function planFold(
  history: StreamMessage[],
  meta: ChatSessionMeta,
  /**
   * The ceiling the **messages** must fit under — the tool schemas' share is
   * already off it (see lib/agent/toolCost). Passing the raw input ceiling here
   * is what let the context bar stand past its own compaction mark with nothing
   * happening: the bar counted the schemas, this did not.
   */
  ceilingTokens: number,
  opts?: {
    force?: boolean;
    /**
     * Where the automatic fold fires, in message tokens — {@link compactTriggerFor}'s
     * answer. Absent = the classic line, `COMPACT_TRIGGER × ceilingTokens`. The
     * post-fold target scales with it ({@link retainTargetFor}).
     */
    triggerTokens?: number;
    /**
     * Turns kept verbatim however far the fold goes. Absent = {@link MIN_KEEP_TURNS}.
     * The state-memory mode (lib/agent/skillState) passes 1: its whole point is
     * that the conversation does not accumulate, and the one turn it keeps is
     * the paper's "latest observation".
     */
    keepTurns?: number;
  },
): FoldPlan | null {
  const force = opts?.force ?? false;
  if (ceilingTokens <= 0) return null;
  const trigger = opts?.triggerTokens ?? ceilingTokens * COMPACT_TRIGGER;
  if (!force && estimateMessagesTokens(history) <= trigger) return null;

  const { prelude, turns } = segmentHistory(history, meta);
  const keepTurns = Math.max(1, opts?.keepTurns ?? MIN_KEEP_TURNS);
  const foldable = turns.length - keepTurns;
  if (foldable <= 0) return null;

  // The rebuilt history's fixed parts: the prelude minus the dropped seed
  // block, plus the summary at its worst-case (budget-cap) size. The old
  // summary is replaced, not joined, so its current size doesn't count.
  const dropSeed = meta.seedContext !== null;
  const keptPrelude = prelude.filter(
    (m) => m !== meta.seedContext && m !== meta.summary,
  );
  const target = retainTargetFor(trigger);
  const baseTokens = estimateMessagesTokens(keptPrelude) + SUMMARY_BUDGET_TOKENS;

  let kept = baseTokens;
  for (const turn of turns.slice(foldable)) {
    kept += estimateMessagesTokens(turn.messages);
  }
  let foldCount = foldable;
  // Walk backwards from the largest fold: un-fold turns while there is room,
  // so the model keeps as much verbatim conversation as the target allows.
  // A forced fold skips this — maximal is the point (see the doc above).
  while (!force && foldCount > 1) {
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
  // Evict ledger entries whose carrier just left the history — that text is no
  // longer in the conversation, so a later mention must re-inject it. Per
  // layer: a folded turn takes its facets with it and leaves a body that lives
  // in the prelude exactly where it is.
  const live = new Set(next);
  pruneLedger(meta, (carrier) => live.has(carrier));
  return next;
}
