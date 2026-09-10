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
import type { AgentEvent, ChangeRecord, PlanRecord, ToolStep } from "./events";
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

  for (const event of log) {
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
    ledger.written = ledger.steps.filter((s) => s.writes.length > 0).length;
    ledger.added = ledger.steps.reduce((n, s) => n + s.added, 0);
    ledger.removed = ledger.steps.reduce((n, s) => n + s.removed, 0);
  }
  return ledgers;
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
