/**
 * Workspace resolution — merging the enabled capability packs into the one
 * view the rest of the app consumes (see ./active).
 *
 * A project used to *be* one profile; it now *enables* several. Each enabled
 * pack contributes its knowledge-base categories and its tasks; the primary
 * pack alone decides the dimensions that cannot be additive — the document
 * model (a project either has an ordered spine or hasn't) and the UI
 * vocabulary (the sidebar can't call a document 章节 and 文档 at once).
 *
 * This module is a pure function from packs to the merged view, so the whole
 * arbitration surface — dedupe, conflicts, ordering — is testable without a
 * filesystem or a store. ./file is its counterpart for profile.json itself.
 */

import { DEFAULT_TASKS, type ProfileCategory, type TaskDef, type WorkspaceProfile } from "./model";

/**
 * One knowledge-base category of the merged view. Same directory contract as
 * `ProfileCategory`; `packIds` records every enabled pack that declares it, in
 * arbitration order, so the workspace settings can group chips by pack. The
 * label is the *first* declarer's — for a shared id like `style`, whichever
 * pack the author put in charge names the folder on screen.
 */
export interface ResolvedCategory extends ProfileCategory {
  packIds: string[];
}

/**
 * One task of the merged view. `packId` is the pack that declared it — the
 * anchor `sectionLabel` / `profileSystemPrompt` resolve against, so a bid
 * task assembled inside a novel-primary project still speaks bid wording.
 *
 * The shared base tasks (续写/润色/…, see `DEFAULT_TASKS`) are declared by
 * every pack and deduped to the primary's copy, so their `packId` is always
 * the primary pack: a continuation in a novel-primary project uses novel
 * wording even with a bid pack enabled. That is deliberate.
 */
export interface ResolvedTask extends TaskDef {
  packId: string;
}

/** The merged view of every enabled pack — what ./active holds. */
export interface ResolvedWorkspace {
  /** The pack in charge of the non-additive dimensions. Always `enabled[0]`. */
  primary: WorkspaceProfile;
  /** Every enabled pack in arbitration order, primary first. */
  enabled: WorkspaceProfile[];
  /** Knowledge-base categories of every enabled pack, deduped by id. */
  categories: ResolvedCategory[];
  /** Tasks of every enabled pack, deduped by id, first declarer wins. */
  tasks: ResolvedTask[];
  /** Human-readable merge problems (task-id conflicts); empty when clean. */
  issues: string[];
}

/** One pack's visible tasks, for surfaces that present the menu by pack. */
export interface PackTaskGroup {
  pack: WorkspaceProfile;
  tasks: ResolvedTask[];
}

/**
 * The visible task menu, grouped by declaring pack in arbitration order.
 *
 * The first group is always the primary's (its task list is never empty), and
 * it includes the shared base tasks — so a single-pack workspace yields
 * exactly one group holding exactly `visibleTasks()`, and a panel that
 * renders group[0] flat and the rest as labelled extras collapses to the
 * pre-pack layout on its own. A secondary pack whose every task deduped away
 * contributes no group rather than an empty heading.
 */
export function visibleTaskGroups(workspace: ResolvedWorkspace): PackTaskGroup[] {
  const visible = workspace.tasks.filter((task) => !task.hidden);
  return workspace.enabled
    .map((pack) => ({ pack, tasks: visible.filter((task) => task.packId === pack.id) }))
    .filter((group) => group.tasks.length > 0);
}

/**
 * Merge `enabled` packs into one workspace view. Pure; never mutates a pack —
 * the built-in profiles are module-level singletons, and a merge that pushed
 * onto their arrays would leak state across projects.
 *
 * `primary` need not appear in `enabled`; it is moved (or added) to the front,
 * so `resolveWorkspace(p, [p])` and `resolveWorkspace(p, [])` are the same
 * single-pack workspace — which behaves exactly like the pre-v2 profile `p`.
 */
export function resolveWorkspace(
  primary: WorkspaceProfile,
  enabled: readonly WorkspaceProfile[],
): ResolvedWorkspace {
  const packs = [primary, ...enabled.filter((p) => p.id !== primary.id)];
  const issues: string[] = [];

  // Categories: a shared id is the *same directory* (that is why sharing is a
  // merge, not a conflict), so the Windows-proof lowercase key from
  // `parseProfile` applies here too.
  const categories: ResolvedCategory[] = [];
  const categoryByKey = new Map<string, ResolvedCategory>();
  for (const pack of packs) {
    for (const cat of pack.categories) {
      const key = cat.id.toLowerCase();
      const existing = categoryByKey.get(key);
      if (existing) {
        existing.packIds.push(pack.id);
        continue;
      }
      const resolved: ResolvedCategory = { ...cat, packIds: [pack.id] };
      categoryByKey.set(key, resolved);
      categories.push(resolved);
    }
  }

  // Tasks: first declarer wins — a task is behaviour, and merging two
  // definitions of one id would silently change what that id means to the
  // three consumers keyed on it (prompt-template `scene`, `token_usage.task`,
  // the execution log).
  //
  // How loudly the loser is dropped depends on which id it is. The base ids
  // (`DEFAULT_TASKS`) are declared by *every* pack, each tuning the shared
  // task's wording to its domain — the primary's tuning winning is the
  // designed outcome, not a problem worth a warning on every open. Any other
  // id colliding means two packs each brought a *different* task under one
  // name (only user packs can produce this), which the author should hear
  // about, because one of those tasks is now unreachable.
  const tasks: ResolvedTask[] = [];
  const sourceById = new Map<string, TaskDef>();
  const baseIds = new Set(DEFAULT_TASKS.map((t) => t.id));
  for (const pack of packs) {
    for (const task of pack.tasks) {
      const source = sourceById.get(task.id);
      if (source) {
        if (source !== task && !baseIds.has(task.id)) {
          issues.push(
            `task id "${task.id}" of pack "${pack.id}" conflicts with an earlier pack — dropped`,
          );
        }
        continue;
      }
      sourceById.set(task.id, task);
      tasks.push({ ...task, packId: pack.id });
    }
  }

  return { primary, enabled: packs, categories, tasks, issues };
}
