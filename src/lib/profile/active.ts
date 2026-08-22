/**
 * The active workspace — the merged view of the open project's enabled packs
 * and user-defined categories.
 *
 * A module-level singleton rather than a Zustand store, because it is read
 * from places that have no React context and must resolve it synchronously:
 * the lore scanner, the agent's tool-schema builder (which needs the category
 * enum at the moment it describes a tool to the model), and the prompt
 * assembler. Threading it through all of them as a parameter would touch
 * every call site for no gain — this mirrors how `i18n` is consumed.
 *
 * Set once per project open (see stores/projectStore) *before* the lore scan
 * and the scaffold, since both are driven by the merged categories. Defaults
 * to the novel pack alone, so anything that reads it before a project opens —
 * and every project created before profiles existed — behaves as it always
 * did.
 *
 * Merging lives in ./resolve; this module only holds the result and answers
 * questions about it. The one wrinkle it owns is *pack-scoped resolution*:
 * `sectionLabel` and friends take an optional `packId` — the pack that
 * declared the task being assembled (`ResolvedTask.packId`) — because a
 * task's prompt may speak the wording of its own domain: a bid task says
 * 【应答大纲】, not 【大纲/写作方向】. Omitting `packId` (or passing an
 * unknown one) resolves the app-level neutral defaults, which is correct for
 * every project-scoped caller (the chat assistant, consistency scan, memory
 * summaries).
 */

import {
  appTerms,
  NOVEL_PROFILE,
  profileLabel,
  DEFAULT_DOC_MODEL,
  DEFAULT_SECTION_LABELS,
  type DocModel,
  type FacetSlot,
  type ImageSlot,
  type SectionId,
  type WorkspaceProfile,
} from "./model";
import {
  BASE_TASK_IDS,
  resolveWorkspace,
  type ResolvedCategory,
  type ResolvedTask,
  type ResolvedWorkspace,
} from "./resolve";

let active: ResolvedWorkspace = resolveWorkspace([NOVEL_PROFILE]);

/** The whole merged view — for surfaces that show packs (workspace settings, AI panel grouping). */
export function activeWorkspace(): ResolvedWorkspace {
  return active;
}

export function setActiveWorkspace(workspace: ResolvedWorkspace): void {
  active = workspace;
}

/** Restore the default (novel, alone) — used when a project is closed. */
export function resetActiveWorkspace(): void {
  active = resolveWorkspace([NOVEL_PROFILE]);
}

/** Look up an enabled pack by id; null when no such pack is enabled. */
export function packById(id: string): WorkspaceProfile | null {
  return active.enabled.find((p) => p.id === id) ?? null;
}

/**
 * The knowledge-base categories of the merged view: every enabled pack's, the
 * project's user-defined ones, and the app-level `custom` bucket.
 *
 * It is a function, not a constant, precisely so it can't be captured at
 * module-load time and freeze to whichever workspace happened to be active
 * when the importer was first evaluated.
 */
export function loreCategories(): readonly ResolvedCategory[] {
  return active.categories;
}

/** Category ids, i.e. the folder names under `.ai-writer/lore/`. */
export function loreCategoryIds(): string[] {
  return active.categories.map((c) => c.id);
}

/** Look up a category of the merged view, or null when the id is unknown. */
export function findCategory(id: string): ResolvedCategory | null {
  return active.categories.find((c) => c.id === id) ?? null;
}

/**
 * Whether `id` is a category of the merged view — the guard every path that
 * turns model- or user-supplied text into a lore directory must pass through.
 */
export function isKnownCategory(id: string): boolean {
  return active.categories.some((c) => c.id === id);
}

/**
 * The facet slots of a category's type schema, in declaration order.
 *
 * Empty is a first-class answer, not a failure: a user-defined category, the
 * `custom` bucket, and every category whose declaring pack is currently
 * disabled all have no schema. **That emptiness is the degraded state** — read
 * it as "an ordinary entry", never as an error, and never as a reason to move
 * or rewrite anything on disk.
 *
 * A slot only ever affects authoring, presentation and prompts. Nothing here
 * may reach the injection path: `selectLore` reads a facet's own frontmatter,
 * so disabling a pack can change what the author *sees*, never what the model
 * sees. See docs/feature/lore/lore-entry-type-plan.md §4.
 */
export function categoryFacetSlots(categoryId: string): readonly FacetSlot[] {
  return findCategory(categoryId)?.slots ?? [];
}

/** The image slots of a category's type schema. Same "empty is fine" contract. */
export function categoryImageSlots(categoryId: string): readonly ImageSlot[] {
  return findCategory(categoryId)?.imageSlots ?? [];
}

/**
 * Resolve one facet slot, or null when the category has no schema or doesn't
 * declare that slot.
 *
 * Null is a real case, like `findTask`'s: a facet's `slot` frontmatter can
 * outlive the pack that defined it, and such a facet is simply unclassified —
 * its value stays on disk untouched so it means something again when the pack
 * comes back. Matched case-insensitively, matching the merge's dedupe.
 */
export function findFacetSlot(categoryId: string, slotId: string): FacetSlot | null {
  const key = slotId.trim().toLowerCase();
  if (!key) return null;
  return categoryFacetSlots(categoryId).find((slot) => slot.id.toLowerCase() === key) ?? null;
}

/**
 * Where an entity goes when the requested category is unusable — a model that
 * invented an id, or an entity whose folder no longer matches any enabled
 * pack. The app-level `custom` misc bucket, which always exists (resolve.ts
 * appends it unconditionally).
 */
export function fallbackCategoryId(): string {
  return isKnownCategory("custom") ? "custom" : active.categories[0].id;
}

/**
 * The category a "new entity" form starts on: the merged view's first — each
 * pack orders its most-used category up front (人物 for a novel, NPC for a
 * TTRPG module), and a packs-free project starts on its first user category
 * (or `custom`). Distinct from `fallbackCategoryId`, which is about
 * recovering from bad input rather than picking a sensible default.
 *
 * Safe to index: the merge always appends the `custom` bucket, so the list is
 * never empty.
 */
export function defaultCategoryId(): string {
  return active.categories[0].id;
}

/**
 * Author-facing label for a prompt context block.
 *
 * With a `packId`, resolves the wording of that pack — the pack that declared
 * the task being assembled (`ResolvedTask.packId`). The chain is pack →
 * neutral defaults, so a pack that overrides only what genuinely differs
 * still produces a complete prompt. Without a `packId` (base tasks, chat,
 * project-scoped callers), the neutral defaults.
 */
export function sectionLabel(id: SectionId, packId?: string): string {
  if (packId) {
    const pack = packById(packId);
    const label = pack?.sections[id];
    if (label) return label;
  }
  return DEFAULT_SECTION_LABELS[id];
}

/**
 * Interpolation params for the built-in instruction templates: the app
 * vocabulary plus the 【…】 block labels, so a template can say
 * "【{{knowledge}}】中出现的名称" and stay correct everywhere.
 *
 * `packId` scopes the *section labels* the way `sectionLabel` does; the terms
 * are app-level and uniform (知识库/文档/…). `isZh` comes from the caller
 * because this module deliberately doesn't import i18n (see the header
 * comment).
 */
export function promptParams(isZh: boolean, packId?: string): Record<string, string> {
  const terms = appTerms(isZh);
  return {
    doc: terms.doc,
    docs: terms.docs,
    group: terms.group,
    kb: terms.kb,
    entry: terms.entry,
    entries: terms.entries,
    knowledge: sectionLabel("knowledge", packId),
    outlineSection: sectionLabel("outline", packId),
    prevTail: sectionLabel("prevTail", packId),
    priorAll: sectionLabel("priorAll", packId),
    priorRecap: sectionLabel("priorRecap", packId),
    recent: sectionLabel("recent", packId),
    selection: sectionLabel("selection", packId),
  };
}

/**
 * The label of the pack a task came from, when that is worth saying — i.e.
 * when the task is a pack's *own* (标书应答的「应答撰写」). Null for the base
 * menu (naming a pack on every ordinary 续写 row is noise, even when a pack
 * re-worded it) and for a pack that is no longer enabled. For display
 * surfaces (usage table, agent log) that want a run attributed the way the
 * grouped task menu presents it.
 */
export function taskPackLabel(task: ResolvedTask, isZh: boolean): string | null {
  if (!task.packId || BASE_TASK_IDS.has(task.id)) return null;
  const pack = packById(task.packId);
  return pack ? profileLabel(pack, isZh) : null;
}

/**
 * Which document machinery applies — the ordered spine, the prior-document
 * bridge, the rolling memory. App-level and always all-on since packs became
 * additive; kept as an accessor so consumers stay wired for a future
 * per-project setting.
 */
export function docModel(): DocModel {
  return DEFAULT_DOC_MODEL;
}

/** Every task of the merged view, in display order (including hidden ones). */
export function profileTasks(): readonly ResolvedTask[] {
  return active.tasks;
}

/** The tasks the panel shows as pickable segments. */
export function visibleTasks(): ResolvedTask[] {
  return active.tasks.filter((task) => !task.hidden);
}

/**
 * Resolve a task id against the merged view, or null when no enabled pack has
 * such a task.
 *
 * Null is a real case, not a defensive branch: a task id can outlive the pack
 * that defined it — persisted UI state, an execution-log entry, a prompt
 * template's `scene` — so every caller has to decide what to do without it
 * rather than assume the lookup succeeds.
 */
export function findTask(id: string): ResolvedTask | null {
  return active.tasks.find((task) => task.id === id) ?? null;
}

/**
 * The task a panel should start on: the first visible one, which the merge
 * order guarantees is the first base task (续写).
 *
 * Safe to index — the base menu always exists, and a workspace whose every
 * task is hidden can't happen (the base menu keeps its visible entries).
 */
export function defaultTask(): ResolvedTask {
  return visibleTasks()[0] ?? active.tasks[0];
}
