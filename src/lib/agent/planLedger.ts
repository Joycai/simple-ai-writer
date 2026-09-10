/**
 * The approved plan as the run's ledger (设计稿 02h 1i, direction D).
 *
 * Before this, approving a lore plan made its card disappear. The writes that
 * followed landed one by one — L1, no card each — and the only trace of them was
 * a tool row per write with 400 characters of raw JSON behind it. The author had
 * approved three sentences and then had nowhere to see what those sentences
 * turned into.
 *
 * The ledger puts the plan back and lets each step grow its receipt: whether it
 * was written, what it added and removed, and — one click away — the change
 * itself. One block for the whole pass, which is the property the plan gate
 * exists to protect: 「一张卡管一整轮」, not one card per write.
 *
 * Built from the turn's persisted log rather than from store state, so it is
 * still there after a restart. The runtime tags each gated write with the index
 * of the step it satisfied (`ToolStep.planStep`, recorded by the gate itself —
 * see `plan.recordMatch`), so nothing here re-derives which step a write
 * belongs to: a second matcher in the UI would eventually disagree with the gate.
 *
 * Top-level events only. A write inside a dispatched sub-run runs against that
 * sub-run's own gate and is shown in its own card.
 */

import { diffInline } from "../diff";
import { rewriteWindows } from "../diff/blocks";
import type { AgentEvent, ChangeRecord, PlanRecord, ToolStep, UndoEvent } from "./events";
import type { LorePlanStep } from "./plan";

/** One approved step and what the run did about it. */
export interface LedgerStep {
  /** The step's index among the run's approved steps. */
  index: number;
  step: LorePlanStep;
  /** The successful writes that carried this step out, in order. */
  writes: ToolStep[];
  added: number;
  removed: number;
  /** The author skipped this step at its card (a destructive step, 1g). */
  skipped: boolean;
  /** The latest undo attempt on any of this step's writes. */
  undo?: UndoEvent;
}

export interface PlanLedger {
  /** The `propose_lore_plan` call that was approved. */
  toolCallId: string;
  plan: PlanRecord;
  steps: LedgerStep[];
  /** Steps with at least one write. */
  written: number;
  added: number;
  removed: number;
  /**
   * Writes the gate refused after this plan was approved — the model reached
   * for something the author had not signed off on (1i 「被拒 · 不在方案里」).
   * Shown rather than hidden: a refusal is the gate working, and the author
   * should be able to see that it did.
   */
  refused: ToolStep[];
}

/** Every approved plan in a turn's log, each with its receipts. */
export function buildPlanLedgers(log: readonly AgentEvent[]): PlanLedger[] {
  const ledgers: PlanLedger[] = [];
  const undos = new Map<string, UndoEvent>();

  for (const event of log) {
    if (event.kind === "undo") {
      undos.set(event.toolCallId, event);
      continue;
    }
    if (event.kind !== "tool-step" || event.parentStep) continue;
    const step = event.step;

    if (step.plan) {
      const plan = step.plan;
      ledgers.push({
        toolCallId: step.toolCallId,
        plan,
        steps: plan.steps.map((s, i) => ({
          index: plan.offset + i,
          step: s,
          writes: [],
          added: 0,
          removed: 0,
          skipped: false,
        })),
        written: 0,
        added: 0,
        removed: 0,
        refused: [],
      });
      continue;
    }

    if (step.planStep !== undefined) {
      const at = step.planStep;
      const ledger = ledgers.find(
        (l) => at >= l.plan.offset && at < l.plan.offset + l.plan.steps.length,
      );
      if (!ledger) continue;
      const entry = ledger.steps[at - ledger.plan.offset];
      if (step.planSkipped) {
        entry.skipped = true;
        continue;
      }
      entry.writes.push(step);
      if (step.change) {
        const receipt = receiptOf(step.change);
        entry.added += receipt.added;
        entry.removed += receipt.removed;
      }
      continue;
    }

    // A refusal before any plan exists has no ledger to belong to — the model
    // simply tried to write first, and the tool row already says so.
    if (step.planRefused && ledgers.length > 0) {
      ledgers[ledgers.length - 1].refused.push(step);
    }
  }

  for (const ledger of ledgers) {
    for (const entry of ledger.steps) {
      const attempts = entry.writes
        .map((w) => undos.get(w.toolCallId))
        .filter((u): u is UndoEvent => u !== undefined)
        .sort((a, b) => b.at - a.at);
      if (attempts[0]) entry.undo = attempts[0];
    }
    ledger.written = ledger.steps.filter((s) => s.writes.length > 0).length;
    ledger.added = ledger.steps.reduce((n, s) => n + s.added, 0);
    ledger.removed = ledger.steps.reduce((n, s) => n + s.removed, 0);
  }
  return ledgers;
}

/** One write of a turn that left a record — what an undo acts on. */
export interface TurnWrite {
  toolCallId: string;
  toolName: string;
  change: ChangeRecord;
}

/**
 * Every write in a turn that left a change record, in order.
 *
 * Top-level only, and only the ones that went through: a skipped step wrote
 * nothing, and an errored call's record (if any) describes a write that did not
 * finish.
 */
export function turnWrites(log: readonly AgentEvent[]): TurnWrite[] {
  const out: TurnWrite[] = [];
  for (const event of log) {
    if (event.kind !== "tool-step" || event.parentStep) continue;
    const { step } = event;
    if (step.status !== "done" || step.planSkipped || !step.change) continue;
    out.push({ toolCallId: step.toolCallId, toolName: step.name, change: step.change });
  }
  return out;
}

/** One write of the turn, as the end-of-turn band shows it (设计稿 02h 1j). */
export interface TurnWriteRow extends TurnWrite {
  added: number;
  removed: number;
  /** Paragraphs a rewrite removed outright — the red number the summary keeps. */
  deletedBlocks: number;
  /** A knowledge-base file rather than a document. */
  lore: boolean;
  /** Carried out a plan step: its row lives in the plan ledger, not here. */
  planned: boolean;
  autoApproved: boolean;
  undo?: UndoEvent;
}

export interface TurnWritesSummary {
  rows: TurnWriteRow[];
  /** Distinct documents written. */
  documents: number;
  /** Distinct knowledge-base entries written. */
  entries: number;
  added: number;
  removed: number;
  deletedBlocks: number;
}

/**
 * Everything a turn wrote, summed — the line the author reads when the cards
 * never appeared (设计稿 02h 1j).
 *
 * The removals stay in it whatever else is folded away: under 本次都批准 this
 * line may be the only thing the author looks at, and 「删 2 段」 is the part of
 * it that has to be impossible to miss.
 */
export function summarizeTurnWrites(log: readonly AgentEvent[]): TurnWritesSummary {
  const undos = new Map<string, UndoEvent>();
  for (const event of log) if (event.kind === "undo") undos.set(event.toolCallId, event);

  const rows: TurnWriteRow[] = [];
  for (const event of log) {
    if (event.kind !== "tool-step" || event.parentStep) continue;
    const { step } = event;
    if (step.status !== "done" || step.planSkipped || !step.change) continue;
    const change = step.change;
    const receipt = receiptOf(change);
    rows.push({
      toolCallId: step.toolCallId,
      toolName: step.name,
      change,
      added: receipt.added,
      removed: receipt.removed,
      deletedBlocks: deletedBlocksOf(change),
      lore: change.path.startsWith(".ai-writer/lore/"),
      planned: step.planStep !== undefined,
      autoApproved: step.autoApproved === true,
      ...(undos.get(step.toolCallId) ? { undo: undos.get(step.toolCallId) } : {}),
    });
  }

  return {
    rows,
    documents: new Set(rows.filter((r) => !r.change.path.startsWith(".ai-writer/")).map((r) => r.change.path)).size,
    entries: new Set(rows.filter((r) => r.lore).map((r) => r.change.entity ?? r.change.path)).size,
    added: rows.reduce((n, r) => n + r.added, 0),
    removed: rows.reduce((n, r) => n + r.removed, 0),
    deletedBlocks: rows.reduce((n, r) => n + r.deletedBlocks, 0),
  };
}

/** Paragraphs an update removed outright, from the kept diff or the kept texts. */
function deletedBlocksOf(change: ChangeRecord): number {
  if (change.action !== "update") return 0;
  if (change.diff) return change.diff.summary.deletedBlocks;
  if (change.before === undefined || change.after === undefined) return 0;
  return rewriteWindows(change.before, change.after, { context: 0, maxWindows: 1 }).summary.deletedBlocks;
}

/** Tool calls whose write has been undone. */
export function undoneIds(log: readonly AgentEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of log) {
    if (event.kind === "undo" && event.outcome === "undone") ids.add(event.toolCallId);
  }
  return ids;
}

/**
 * What one write added and removed, in characters.
 *
 * Token-level when both texts were kept, because that is the number the design
 * draws — 「金发」→「银发」 is +1 −1, not the length of the whole entry twice.
 * Whole files for a create or a delete. When the texts were dropped past the
 * record's cap, the net change in size is the most that can honestly be said.
 */
export function receiptOf(change: ChangeRecord): { added: number; removed: number } {
  if (change.action === "create") return { added: change.afterChars, removed: 0 };
  if (change.action === "delete") return { added: 0, removed: change.beforeChars };
  if (change.before !== undefined && change.after !== undefined) {
    const segs = diffInline(change.before, change.after);
    if (segs) {
      let added = 0;
      let removed = 0;
      for (const seg of segs) {
        if (seg.type === "add") added += seg.text.length;
        else if (seg.type === "del") removed += seg.text.length;
      }
      return { added, removed };
    }
  }
  const net = change.afterChars - change.beforeChars;
  return { added: Math.max(0, net), removed: Math.max(0, -net) };
}
