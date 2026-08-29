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

import { sameCollection, type LoreIndex } from "../lore";
import { loreCategories } from "../profile/active";
import { findEntityByName } from "./tools";

export type LorePlanAction = "create" | "update" | "move" | "delete";

export const LORE_PLAN_ACTIONS: LorePlanAction[] = ["create", "update", "move", "delete"];

/**
 * What kind of thing a step acts on. Absent means `"entity"` — every plan
 * written before collections existed, and the overwhelming majority since.
 *
 * The second and third kinds exist for one reason: **a reorganisation pass is
 * not reviewable one entry at a time.** 「把 200 条按作品归类」 as 200 entity
 * steps is a wall of text, and an author who cannot read the card does not
 * really approve it — the gate degrades into a rubber stamp, which is worse
 * than no gate because it looks like one. One step per *collection*, carrying
 * the entries that move, is both readable and the actual unit of the decision
 * the author is making.
 *
 * The four actions are reused rather than extended (no "file"/"rename" verbs):
 * filing changes a collection's membership, so it is an `update` **of the
 * collection**; renaming one relocates its identity, so it is a `move`. That
 * keeps the schema enum — which rides resident on every round — from growing.
 */
export type LorePlanTarget = "entity" | "collection" | "category";

export const LORE_PLAN_TARGETS: LorePlanTarget[] = ["entity", "collection", "category"];

export interface LorePlanStep {
  action: LorePlanAction;
  /**
   * What this step acts on: absent = an entity (the default), otherwise the
   * collection or category named by `entity`.
   */
  target?: LorePlanTarget;
  /**
   * The name the author will recognise: an entity name, or — when `target` is
   * collection/category — that collection's or category's name.
   *
   * One field rather than three, because the gate's question is always the
   * same ("which named thing does this touch?") and a resident schema pays for
   * every property it declares.
   */
  entity: string;
  /**
   * Collection / category steps: which entries this step moves. Empty/absent
   * means the step is about the collection or category *itself* (create /
   * rename / delete), not its membership.
   *
   * This is the authorisation boundary for a reorganisation pass:
   * `file_lore_entries` — and, for a category step, `move_lore_entity` — may
   * only touch entries this list names. Approving 「归入 12 条」 is not
   * approving the 13th.
   */
  members?: string[];
  /** "update" only: which file in the entity dir. Omitted = any file. */
  file?: string;
  /** What the change is, in the author's language. Shown on the card. */
  detail: string;
}

/** A step's target, with the default applied. */
export function stepTarget(step: LorePlanStep): LorePlanTarget {
  return step.target ?? "entity";
}

/**
 * 一份已批准的方案要装载哪些延迟工具组（`runtime.ts` 按方案形状下发）。
 *
 * 这条映射住在这里而不是在 runtime 的循环里，因为它是**关于 target 轴的知识**：
 * 哪一种步骤由哪一个工具兑现。规则写在别处的代价刚刚被踩过一次——给分类补上
 * 「搬入」这条路时，只有 target 那一侧改了，于是一份只有一条 category/move 步骤的
 * 方案（正是这次要做的那种「一行卡」）会把 `lore_organize` 装上，却**不装**
 * `move_lore_entity`：作者批准了，模型却拿不到兑现它的工具，而且不报错——它只是
 * 看不见那个工具名。
 *
 *   lore_write     条目步骤（写正文/元数据/改名…），以及**搬进某个分类**那种
 *                  category 步骤——兑现它的是 `move_lore_entity`，它在这一组里。
 *   lore_organize  集合步骤（建/改名/删/归集），以及**新建分类**那种 category
 *                  步骤——兑现它们的是 `manage_collection` / `file_lore_entries` /
 *                  `create_lore_category`。
 *
 * 两边都不是「有非条目步骤就全装」：批准一份「改写条目正文」的方案不该顺手把集合
 * 工具塞进来，反过来也一样。
 */
export function planLoadsEntityWrites(steps: readonly LorePlanStep[]): boolean {
  return steps.some(
    (s) => stepTarget(s) === "entity" || (stepTarget(s) === "category" && s.action === "move"),
  );
}

/** @see planLoadsEntityWrites */
export function planLoadsOrganize(steps: readonly LorePlanStep[]): boolean {
  return steps.some(
    (s) => stepTarget(s) === "collection" || (stepTarget(s) === "category" && s.action === "create"),
  );
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

/**
 * Whether a plan step's category and a tool call's category name the same one.
 *
 * The two sides speak different dialects and both are legitimate. A plan is
 * written for the author, so its step says 「势力」; `move_lore_entity` takes the
 * **folder id** (`factions`) because that is what its enum offers and what the
 * scanner trusts. Exact string equality would refuse every bulk move whose card
 * the author had just approved — a gate failure that reads as the agent
 * malfunctioning, exactly what `sameEntity` exists to prevent one axis over.
 *
 * `loreCategories()` is read here rather than closed over: the enabled packs
 * change while the app is running, and a module-scope copy would freeze the
 * label table to whichever workspace loaded first (see lib/profile/active).
 */
function sameCategory(planned: string, called: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  if (norm(planned) === norm(called)) return true;
  const idOf = (s: string): string | null => {
    const n = norm(s);
    const hit = loreCategories().find(
      (c) => norm(c.id) === n || norm(c.labelZh) === n || norm(c.labelEn) === n,
    );
    return hit ? hit.id : null;
  };
  const a = idOf(planned);
  return a !== null && a === idOf(called);
}

/** One-line rendering of a step, for the error text the model has to act on. */
export function describeStep(step: LorePlanStep): string {
  const kind = stepTarget(step);
  if (kind !== "entity") {
    const members = step.members?.length ? ` [${step.members.join(", ")}]` : "";
    return `${step.action} ${kind} "${step.entity}"${members} — ${step.detail}`;
  }
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
  opts?: {
    /** Which kind of thing the call touches. Default "entity". */
    target?: LorePlanTarget;
    /**
     * Collection steps: the entry being filed. Checked against the step's
     * `members`, so a filing pass can only touch the entries the author saw
     * listed on the card.
     */
    member?: string;
  },
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

  const target = opts?.target ?? "entity";

  // Collection / category steps match on their own terms: no file scoping, and
  // — when the step listed members — the entry being filed must be one of them.
  if (target !== "entity") {
    const idx = gate.steps.findIndex(
      (s) =>
        stepTarget(s) === target &&
        s.action === action &&
        (target === "collection"
          ? sameCollection(s.entity, entity)
          : sameCategory(s.entity, entity)) &&
        (!opts?.member ||
          !s.members?.length ||
          s.members.some((m) => sameEntity(loreIndex, m, opts.member!))),
    );
    if (idx < 0) {
      return {
        ok: false,
        message:
          `Error: the approved plan does not cover "${action}" on the ${target} "${entity}"` +
          `${opts?.member ? ` for "${opts.member}"` : ""}. ` +
          `Approved steps are:\n${gate.steps.map((s) => `  - ${describeStep(s)}`).join("\n")}\n` +
          "Do not improvise beyond them. If the plan really should change, call propose_lore_plan again with the revised steps and wait for the author.",
      };
    }
    gate.fulfilled.add(idx);
    return { ok: true, step: gate.steps[idx] };
  }

  const at = gate.steps.findIndex(
    (s) =>
      // Entity calls never match a collection/category step, and vice versa —
      // otherwise "update 《漕运纪》" (the collection) would authorise rewriting
      // an entity that happens to share the name.
      stepTarget(s) === "entity" &&
      // create_lore_facet and update_lore_file both land a file on an entity
      // that already exists (create_lore_entity refuses that; it only makes
      // brand-new entities). Both are gated as "update" (writeTools.ts) —
      // including create_lore_facet, whose whole subject is a file that does
      // not exist yet — but a plan author has no way to tell
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
