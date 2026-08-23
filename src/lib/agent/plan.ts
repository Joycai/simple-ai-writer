/**
 * Plan-first gate for lore changes.
 *
 * Lore writes are L1 — they apply the moment the model calls them, with a
 * backup as the only safety valve. That is the right latency for "go do it",
 * but it leaves the author no say in *what* gets done, and no guarantee that
 * what lands matches what the agent said it would do.
 *
 * So lore writes are gated on an approved plan instead of on per-write cards:
 *
 *   propose_lore_plan  → blocks on the author's decision (one card, N steps)
 *   approved           → the steps are recorded in this run's gate
 *   create/update/move/delete_lore_entity → refused unless a recorded step
 *                        covers that entity (and, for a file-scoped write,
 *                        that file) — see checkPlan for the one deliberate
 *                        exception, "create" vs "update" on a facet file
 *
 * One card for a whole housekeeping pass, and the writes that follow are
 * provably the ones on it. What the gate can check is *which entity, which
 * file, which action* — not the prose, which no gate could verify. A step's
 * `detail` is therefore echoed back in the write's tool result, so the author
 * reads the intended change and the delivered change side by side in the log.
 *
 * The gate is per-run: the caller creates one, hands it to the runtime through
 * ToolContext, and it dies with the run. A later turn re-asks. Approving a
 * second plan mid-run appends to the recorded steps rather than replacing them,
 * so "also fix Kael while you're there" doesn't silently revoke the first.
 */

import type { LoreIndex } from "../lore";
import { findEntityByName } from "./tools";

export type LorePlanAction = "create" | "update" | "move" | "delete";

export const LORE_PLAN_ACTIONS: LorePlanAction[] = ["create", "update", "move", "delete"];

export interface LorePlanStep {
  action: LorePlanAction;
  /** Entity the step acts on — the name the author will recognise. */
  entity: string;
  /** "update" only: which file in the entity dir. Omitted = any file. */
  file?: string;
  /** What the change is, in the author's language. Shown on the card. */
  detail: string;
}

export interface LorePlan {
  id: string;
  /** One line on what the pass is for, shown above the steps. */
  summary?: string;
  steps: LorePlanStep[];
}

export type PlanDecision = { approved: true } | { approved: false; reason?: string };

/** Per-run record of what the author signed off on. */
export interface PlanGate {
  /** Steps approved so far this run, in approval order. */
  steps: LorePlanStep[];
  /** Indices of steps some write has actually satisfied. */
  fulfilled: Set<number>;
  /** True once any plan has been put to the author, approved or not. */
  asked: boolean;
}

export function createPlanGate(): PlanGate {
  return { steps: [], fulfilled: new Set(), asked: false };
}

/**
 * Whether a plan step's entity and a tool call's entity name the same thing.
 *
 * Plain string equality is not enough: a plan may say "Ava" and the write may
 * use the alias "阿瓦" — the same entity, and refusing that would be a gate
 * failure the author reads as the agent malfunctioning. Both sides are resolved
 * through the lore index when they can be; the string compare stays as the
 * fallback that `create` (no entity on disk yet) relies on.
 */
function sameEntity(loreIndex: LoreIndex, planned: string, called: string): boolean {
  const a = planned.trim().toLowerCase();
  const b = called.trim().toLowerCase();
  if (a === b) return true;
  const ea = findEntityByName(loreIndex, planned);
  const eb = findEntityByName(loreIndex, called);
  return !!ea && ea === eb;
}

/** One-line rendering of a step, for the error text the model has to act on. */
export function describeStep(step: LorePlanStep): string {
  const target = step.file ? `${step.entity} / ${step.file}` : step.entity;
  return `${step.action} ${target} — ${step.detail}`;
}

export type PlanCheck =
  | { ok: true; step: LorePlanStep }
  | { ok: false; message: string };

/**
 * Gate one lore write. Returns the covering step (marking it fulfilled) or the
 * error text to hand back to the model — always phrased as the next action to
 * take, since a bare refusal tends to make models retry the same call.
 */
export function checkPlan(
  gate: PlanGate | undefined,
  loreIndex: LoreIndex,
  action: LorePlanAction,
  entity: string,
  file?: string,
): PlanCheck {
  if (!gate) {
    return {
      ok: false,
      message:
        "Error: this surface cannot review lore plans, so lore changes are unavailable here. Report what you would change instead of calling this tool.",
    };
  }
  if (gate.steps.length === 0) {
    return {
      ok: false,
      message:
        "Error: lore changes need an approved plan first. Call propose_lore_plan listing every entity you intend to create/update/move/delete and what you will change about each, wait for the author's decision, then carry out exactly those steps." +
        (gate.asked ? " Your previous plan was not approved — revise it and propose again." : ""),
    };
  }

  const at = gate.steps.findIndex(
    (s) =>
      // update_lore_file is the only tool that ever lands a file — including a
      // facet that doesn't exist yet on an entity that does (create_lore_entity
      // refuses that; it only makes brand-new entities). Its call is always
      // gated as "update" (writeTools.ts), but a plan author has no way to tell
      // "new facet" from "edit existing facet" apart except by writing "create"
      // — and that's a sensible word for genuinely new content. So for a
      // file-scoped call, accept either label; only the entity-level actions
      // (create_lore_entity/move/delete, all called with no `file`) still need
      // an exact match.
      (s.action === action || (action === "update" && !!file && s.action === "create")) &&
      sameEntity(loreIndex, s.entity, entity) &&
      // A step that names a file pins the write to exactly that file; a step
      // that doesn't covers any file in that entity. A file-scoped step must
      // NOT satisfy a call with no file — "delete Ava / armor.md" authorises
      // dropping one facet, never the whole entity.
      (!s.file || (!!file && s.file.trim().toLowerCase() === file.trim().toLowerCase())),
  );
  if (at < 0) {
    return {
      ok: false,
      message:
        `Error: the approved plan does not cover "${action}" on "${entity}"${file ? ` (${file})` : ""}. ` +
        `Approved steps are:\n${gate.steps.map((s) => `  - ${describeStep(s)}`).join("\n")}\n` +
        "Do not improvise beyond them. If the plan really should change, call propose_lore_plan again with the revised steps and wait for the author.",
    };
  }

  gate.fulfilled.add(at);
  return { ok: true, step: gate.steps[at] };
}

/** Steps the author approved that no write has satisfied yet. */
export function outstandingSteps(gate: PlanGate): LorePlanStep[] {
  return gate.steps.filter((_, i) => !gate.fulfilled.has(i));
}
