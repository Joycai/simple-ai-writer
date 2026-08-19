/**
 * Workspace resolution — merging the enabled capability packs (plus the
 * project's user-defined categories) into the one view the rest of the app
 * consumes (see ./active).
 *
 * Packs are purely **additive** and equal: each contributes knowledge-base
 * categories and tasks, in enabled order. The base task menu
 * (续写/润色/改写/总结/自定义/agent) is app-level — always present, whatever
 * packs are enabled, including none. A pack may *override* a base task by
 * declaring its id (the novel pack re-points instructions at fiction wording);
 * the first enabled pack to do so wins.
 *
 * The knowledge base likewise always exists: its categories are the union of
 * every enabled pack's, the project's own user-defined ones, and the app-level
 * `custom` misc bucket — so a project with no packs at all still has a working
 * knowledge base the author organises by hand.
 *
 * There is deliberately no "primary pack" here any more. It used to own the
 * non-additive dimensions (vocabulary, doc model, persona); those are
 * app-level now, which is what makes packs order-insensitive except for the
 * narrow base-task-override arbitration above.
 *
 * This module is a pure function from packs to the merged view, so the whole
 * arbitration surface — dedupe, conflicts, ordering — is testable without a
 * filesystem or a store. ./file is its counterpart for profile.json itself.
 */

import { DEFAULT_TASKS, type ProfileCategory, type TaskDef, type WorkspaceProfile } from "./model";

/**
 * The app-level misc bucket. Always last in the merged view and always
 * present, so `fallbackCategoryId()` has somewhere for an unclassifiable
 * entity whatever the pack selection is. No pack declares it.
 */
export const CUSTOM_CATEGORY: ProfileCategory = {
  id: "custom",
  labelZh: "自定义",
  labelEn: "Custom",
};

/** Base task ids — the menu every project has, before any pack adds to it. */
export const BASE_TASK_IDS: ReadonlySet<string> = new Set(DEFAULT_TASKS.map((t) => t.id));

/**
 * One knowledge-base category of the merged view. Same directory contract as
 * `ProfileCategory`; `packIds` records every enabled pack that declares it, in
 * enabled order — empty for a user-defined category and for the app-level
 * `custom` bucket. The label is the *first* declarer's. `userDefined` marks
 * the project's own categories: the only ones the settings UI lets the author
 * rename or remove.
 *
 * The type schema inherited from `ProfileCategory` (`slots` / `imageSlots`) is
 * the **union** of every declarer's, first-declarer-wins per slot id — see
 * `unionSlots`.
 */
export interface ResolvedCategory extends ProfileCategory {
  packIds: string[];
  userDefined?: boolean;
}

/**
 * Union a later declarer's slot list into the resolved one: slots are added by
 * id and the **first declarer wins** for a shared id — the same rule as the
 * label, and what keeps packs order-insensitive beyond that. Additive because
 * that is what a pack is: enabling a second pack may give a shared category
 * more facets worth filling, never a different meaning for one it already had.
 *
 * Returns a fresh array (or the original when there is nothing to add), never
 * mutating either side: `from` is a built-in pack's module-level array, and
 * appending to it would leak this project's merge into every other one.
 */
function unionSlots<T extends { id: string }>(
  into: T[] | undefined,
  from: readonly T[] | undefined,
): T[] | undefined {
  if (!from || from.length === 0) return into;
  const out = into ? [...into] : [];
  const seen = new Set(out.map((slot) => slot.id.toLowerCase()));
  for (const slot of from) {
    const key = slot.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
  }
  return out;
}

/**
 * One task of the merged view. `packId` is the pack that declared it — the
 * anchor `sectionLabel` resolves against, so a bid task still speaks bid
 * wording (【应答大纲】) whatever else is enabled. Undefined for an app-level
 * base task no pack overrode; a base task a pack *did* override carries that
 * pack's id (novel's 续写 resolves novel wording) while keeping its base menu
 * position.
 */
export interface ResolvedTask extends TaskDef {
  packId?: string;
}

/** The merged view of every enabled pack — what ./active holds. */
export interface ResolvedWorkspace {
  /** Every enabled pack, in the order the author enabled them. */
  enabled: WorkspaceProfile[];
  /**
   * Knowledge-base categories: pack union (enabled order), then user-defined,
   * then the `custom` bucket. Deduped by lowercased id.
   */
  categories: ResolvedCategory[];
  /** The base menu plus every pack's own tasks, deduped by id. */
  tasks: ResolvedTask[];
  /** Human-readable merge problems (task-id conflicts); empty when clean. */
  issues: string[];
}

/** One group of the visible task menu — `pack` is null for the base tasks. */
export interface PackTaskGroup {
  pack: WorkspaceProfile | null;
  tasks: ResolvedTask[];
}

/**
 * The visible task menu, grouped for surfaces that present it by origin: the
 * base tasks first (rendered flat — they are the menu every project has, and
 * an overridden base task still belongs here), then each pack's own tasks
 * under that pack's label, in enabled order. A pack whose tasks are all base
 * overrides contributes no group rather than an empty heading.
 */
export function visibleTaskGroups(workspace: ResolvedWorkspace): PackTaskGroup[] {
  const visible = workspace.tasks.filter((task) => !task.hidden);
  const groups: PackTaskGroup[] = [];
  const base = visible.filter((task) => BASE_TASK_IDS.has(task.id));
  if (base.length > 0) groups.push({ pack: null, tasks: base });
  for (const pack of workspace.enabled) {
    const tasks = visible.filter(
      (task) => task.packId === pack.id && !BASE_TASK_IDS.has(task.id),
    );
    if (tasks.length > 0) groups.push({ pack, tasks });
  }
  return groups;
}

/**
 * Which of `packs` declare a knowledge-base category — used to explain an
 * **orphan** category: "this entry's type comes from a pack that isn't enabled"
 * (设计稿 03 屏 23), and to offer the one button that fixes it.
 *
 * Deliberately not part of the merge, and deliberately not what labels an orphan
 * category: borrowing a disabled pack's label would present the category as if
 * its schema were in effect (see lib/lore/categories). Naming the pack is the
 * opposite move — it says *why* the schema is absent, which is only honest when
 * the UI shows it as absent.
 *
 * Matched case-insensitively, like every other category-id comparison.
 */
export function packsDeclaringCategory(
  categoryId: string,
  packs: readonly WorkspaceProfile[],
): WorkspaceProfile[] {
  const key = categoryId.trim().toLowerCase();
  if (!key) return [];
  return packs.filter((pack) => pack.categories.some((cat) => cat.id.toLowerCase() === key));
}

/**
 * Merge `enabled` packs and the project's user-defined categories into one
 * workspace view. Pure; never mutates a pack — the built-in profiles are
 * module-level singletons, and a merge that pushed onto their arrays would
 * leak state across projects. An empty `enabled` is valid and yields the
 * app-level baseline: the base tasks, the user categories, the misc bucket.
 */
export function resolveWorkspace(
  enabled: readonly WorkspaceProfile[],
  userCategories: readonly ProfileCategory[] = [],
): ResolvedWorkspace {
  // Dedupe packs by id defensively — ./file already rejects duplicates.
  const packs: WorkspaceProfile[] = [];
  for (const pack of enabled) {
    if (!packs.some((p) => p.id === pack.id)) packs.push(pack);
  }
  const issues: string[] = [];

  // Categories: a shared id is the *same directory* (that is why sharing is a
  // merge, not a conflict), so the Windows-proof lowercase key from
  // `parseProfile` applies here too. User-defined categories yield to a pack's
  // when the id collides — the pack's label is the one its tasks were written
  // against — and `custom` comes last whatever declared it.
  const categories: ResolvedCategory[] = [];
  const categoryByKey = new Map<string, ResolvedCategory>();
  const addCategory = (cat: ProfileCategory, packId: string | null, userDefined: boolean) => {
    const key = cat.id.toLowerCase();
    const existing = categoryByKey.get(key);
    if (existing) {
      if (packId) existing.packIds.push(packId);
      // Only assign when there is something to hold: a plain category must keep
      // *no* schema key at all (see `parseCategory`).
      const slots = unionSlots(existing.slots, cat.slots);
      if (slots) existing.slots = slots;
      const imageSlots = unionSlots(existing.imageSlots, cat.imageSlots);
      if (imageSlots) existing.imageSlots = imageSlots;
      return;
    }
    const resolved: ResolvedCategory = { ...cat, packIds: packId ? [packId] : [] };
    // Copy the schema arrays the spread just aliased — they belong to a built-in
    // pack singleton, and `unionSlots` would otherwise be handed them to grow.
    if (cat.slots) resolved.slots = [...cat.slots];
    if (cat.imageSlots) resolved.imageSlots = [...cat.imageSlots];
    if (userDefined) resolved.userDefined = true;
    categoryByKey.set(key, resolved);
    categories.push(resolved);
  };
  for (const pack of packs) {
    for (const cat of pack.categories) addCategory(cat, pack.id, false);
  }
  for (const cat of userCategories) addCategory(cat, null, true);
  addCategory(CUSTOM_CATEGORY, null, false);

  // Tasks: the app-level base menu first, then each pack's. A pack declaring a
  // base id *overrides* that base task in place (first enabled pack wins,
  // silently — re-tuning the shared tasks is what base overrides are for). Any
  // other colliding id means two packs each brought a *different* task under
  // one name, which the author should hear about, because one of those tasks
  // is now unreachable. First declarer wins there too: a task is behaviour,
  // and merging two definitions of one id would silently change what that id
  // means to the three consumers keyed on it (prompt-template `scene`,
  // `token_usage.task`, the execution log).
  const tasks: ResolvedTask[] = DEFAULT_TASKS.map((t) => ({ ...t }));
  const indexById = new Map<string, number>(tasks.map((t, i) => [t.id, i]));
  const overridden = new Set<string>();
  for (const pack of packs) {
    for (const task of pack.tasks) {
      const index = indexById.get(task.id);
      if (index === undefined) {
        indexById.set(task.id, tasks.length);
        tasks.push({ ...task, packId: pack.id });
        continue;
      }
      if (BASE_TASK_IDS.has(task.id)) {
        if (!overridden.has(task.id)) {
          overridden.add(task.id);
          tasks[index] = { ...task, packId: pack.id };
        }
        continue;
      }
      issues.push(
        `task id "${task.id}" of pack "${pack.id}" conflicts with an earlier pack — dropped`,
      );
    }
  }

  return { enabled: packs, categories, tasks, issues };
}
