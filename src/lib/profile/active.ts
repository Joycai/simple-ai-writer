/**
 * The active workspace — the merged view of the open project's enabled packs.
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
 * `sectionLabel` and friends take an optional `packId`, because a task's
 * prompt must speak the wording of the pack that declared the task — a bid
 * task in a novel-primary project says 【企业知识库】, not 【设定资料】.
 * Omitting `packId` resolves against the primary pack, which is both the
 * pre-v2 behaviour and correct for every project-scoped caller (the chat
 * assistant, consistency scan, memory summaries).
 */

import {
  NOVEL_PROFILE,
  profileTerms,
  DEFAULT_SECTION_LABELS,
  type DocModel,
  type SectionId,
  type WorkspaceProfile,
} from "./model";
import {
  resolveWorkspace,
  type ResolvedCategory,
  type ResolvedTask,
  type ResolvedWorkspace,
} from "./resolve";

let active: ResolvedWorkspace = resolveWorkspace(NOVEL_PROFILE, []);

/**
 * The primary pack of the open project — the owner of the non-additive
 * dimensions: docModel, UI terms, the fallback wording. Callers that used to
 * read `activeProfile()` for those read this; callers that meant "the task
 * menu" or "the categories" read the merged accessors below instead.
 */
export function primaryPack(): WorkspaceProfile {
  return active.primary;
}

/** The whole merged view — for surfaces that show packs (workspace settings, AI panel grouping). */
export function activeWorkspace(): ResolvedWorkspace {
  return active;
}

export function setActiveWorkspace(workspace: ResolvedWorkspace): void {
  active = workspace;
}

/** Restore the default (novel, alone) — used when a project is closed. */
export function resetActiveWorkspace(): void {
  active = resolveWorkspace(NOVEL_PROFILE, []);
}

/** Look up an enabled pack by id; null when no such pack is enabled. */
export function packById(id: string): WorkspaceProfile | null {
  return active.enabled.find((p) => p.id === id) ?? null;
}

/**
 * The knowledge-base categories of every enabled pack, merged.
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
 * Whether `id` is a category of any enabled pack — the guard every path that
 * turns model- or user-supplied text into a lore directory must pass through.
 */
export function isKnownCategory(id: string): boolean {
  return active.categories.some((c) => c.id === id);
}

/**
 * Where an entity goes when the requested category is unusable — a model that
 * invented an id, or an entity whose folder no longer matches any enabled
 * pack. Prefers an explicit "custom" bucket, since a misc pile is exactly what
 * an unclassifiable entity wants, and otherwise takes the first category.
 */
export function fallbackCategoryId(): string {
  return isKnownCategory("custom") ? "custom" : active.categories[0].id;
}

/**
 * The category a "new entity" form starts on: the merged view's first, which
 * is the primary pack's first — each pack orders its most-used category up
 * front (人物 for a novel, NPC for a TTRPG module). Distinct from
 * `fallbackCategoryId`, which is about recovering from bad input rather than
 * picking a sensible default.
 *
 * Safe to index: every pack has at least one category (`parseProfile` rejects
 * an empty list rather than producing one), and the merge keeps them all.
 */
export function defaultCategoryId(): string {
  return active.categories[0].id;
}

/**
 * Author-facing label for a prompt context block.
 *
 * With a `packId`, resolves the wording of that pack — the pack that declared
 * the task being assembled (`ResolvedTask.packId`). The chain is pack →
 * primary → defaults, so a pack that overrides only what genuinely differs
 * still produces a complete prompt. Without a `packId`, the primary's wording,
 * which is the pre-v2 behaviour.
 */
export function sectionLabel(id: SectionId, packId?: string): string {
  if (packId) {
    const pack = packById(packId);
    const label = pack?.sections[id];
    if (label) return label;
  }
  return active.primary.sections[id] ?? DEFAULT_SECTION_LABELS[id];
}

/**
 * The system prompt key to fall back to. Same pack → primary chain as
 * `sectionLabel` (every built-in pack declares its own key; the chain is for
 * hand-written packs that leave it out).
 */
export function systemPromptKeyFor(packId?: string): string {
  if (packId) {
    const pack = packById(packId);
    if (pack) return pack.systemPromptKey;
  }
  return active.primary.systemPromptKey;
}

/**
 * Interpolation params for the built-in instruction templates: the UI terms
 * plus the 【…】 block labels, so a template can say "【{{knowledge}}】中出现
 * 的名称" and read 【企业知识库】 in a bid project.
 *
 * `packId` scopes the *section labels* the way `sectionLabel` does. The terms
 * stay the primary pack's on purpose: they name project-level concepts (what
 * a document is, what the sidebar shows), and a task template mixing another
 * pack's vocabulary into them would contradict the UI around the result.
 * `isZh` comes from the caller because this module deliberately doesn't
 * import i18n (see the header comment).
 */
export function promptParams(isZh: boolean, packId?: string): Record<string, string> {
  const terms = profileTerms(active.primary, isZh);
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
 * Which novel-shaped document machinery applies — the ordered spine, the
 * prior-document bridge, the rolling memory. The primary pack's alone: a
 * project either is an ordered book or isn't, whatever else it has enabled.
 */
export function docModel(): DocModel {
  return active.primary.docModel;
}

/** Every task of every enabled pack, in display order (including hidden ones). */
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
 * The task a panel should start on: the first visible one — which the merge
 * order guarantees is the primary pack's first visible task.
 *
 * Safe to index — `parseProfile` refuses to produce an empty task list, and a
 * pack whose every task is hidden would have no usable UI anyway, so the
 * fallback to the first task at all is deliberate.
 */
export function defaultTask(): ResolvedTask {
  return visibleTasks()[0] ?? active.tasks[0];
}
