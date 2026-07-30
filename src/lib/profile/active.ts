/**
 * The active workspace profile.
 *
 * A module-level singleton rather than a Zustand store, because the profile is
 * read from places that have no React context and must resolve it
 * synchronously: the lore scanner, the agent's tool-schema builder (which needs
 * the category enum at the moment it describes a tool to the model), and the
 * prompt assembler. Threading it through all of them as a parameter would touch
 * every call site for no gain — this mirrors how `i18n` is consumed.
 *
 * Set once per project open (see stores/projectStore) *before* the lore scan and
 * the scaffold, since both are driven by the profile's categories. Defaults to
 * the novel profile, so anything that reads it before a project opens — and
 * every project created before profiles existed — behaves as it always did.
 */

import { NOVEL_PROFILE, type DocModel, type ProfileCategory, type SectionId, type TaskDef, type WorkspaceProfile, DEFAULT_SECTION_LABELS } from "./model";

let active: WorkspaceProfile = NOVEL_PROFILE;

/** The profile driving the currently open project. */
export function activeProfile(): WorkspaceProfile {
  return active;
}

export function setActiveProfile(profile: WorkspaceProfile): void {
  active = profile;
}

/** Restore the default (novel) profile — used when a project is closed. */
export function resetActiveProfile(): void {
  active = NOVEL_PROFILE;
}

/**
 * The knowledge-base categories of the active profile.
 *
 * Replaces the former `LORE_CATEGORIES` constant. It is a function, not a
 * constant, precisely so it can't be captured at module-load time and freeze to
 * whichever profile happened to be active when the importer was first evaluated.
 */
export function loreCategories(): readonly ProfileCategory[] {
  return active.categories;
}

/** Category ids, i.e. the folder names under `.ai-writer/lore/`. */
export function loreCategoryIds(): string[] {
  return active.categories.map((c) => c.id);
}

/** Look up a category of the active profile, or null when the id is unknown. */
export function findCategory(id: string): ProfileCategory | null {
  return active.categories.find((c) => c.id === id) ?? null;
}

/**
 * Whether `id` is a category of the active profile — the guard every path that
 * turns model- or user-supplied text into a lore directory must pass through.
 */
export function isKnownCategory(id: string): boolean {
  return active.categories.some((c) => c.id === id);
}

/**
 * Where an entity goes when the requested category is unusable — a model that
 * invented an id, or an entity whose folder no longer matches the profile.
 * Prefers an explicit "custom" bucket, since a misc pile is exactly what an
 * unclassifiable entity wants, and otherwise takes the first category.
 */
export function fallbackCategoryId(): string {
  return isKnownCategory("custom") ? "custom" : active.categories[0].id;
}

/**
 * The category a "new entity" form starts on: the profile's first, which each
 * profile orders to put its most-used category up front (人物 for a novel, NPC
 * for a TTRPG module). Distinct from `fallbackCategoryId`, which is about
 * recovering from bad input rather than picking a sensible default.
 *
 * Safe to index: a profile always has at least one category (`parseProfile`
 * rejects an empty list rather than producing one).
 */
export function defaultCategoryId(): string {
  return active.categories[0].id;
}

/** Author-facing label for a prompt context block, per the active profile. */
export function sectionLabel(id: SectionId): string {
  return active.sections[id] ?? DEFAULT_SECTION_LABELS[id];
}

/**
 * Which novel-shaped document machinery applies — the ordered spine, the
 * prior-document bridge, the rolling memory. See `DocModel`.
 */
export function docModel(): DocModel {
  return active.docModel;
}

/** Every task this profile offers, in display order (including hidden ones). */
export function profileTasks(): readonly TaskDef[] {
  return active.tasks;
}

/** The tasks the panel shows as pickable segments. */
export function visibleTasks(): TaskDef[] {
  return active.tasks.filter((task) => !task.hidden);
}

/**
 * Resolve a task id against the active profile, or null when this profile has no
 * such task.
 *
 * Null is a real case, not a defensive branch: a task id can outlive the profile
 * that defined it — persisted UI state, an execution-log entry, a prompt
 * template's `scene` — so every caller has to decide what to do without it
 * rather than assume the lookup succeeds.
 */
export function findTask(id: string): TaskDef | null {
  return active.tasks.find((task) => task.id === id) ?? null;
}

/**
 * The task a panel should start on: the first visible one.
 *
 * Safe to index — `parseProfile` refuses to produce an empty task list, and a
 * profile whose every task is hidden would have no usable UI anyway, so the
 * fallback to the first task at all is deliberate.
 */
export function defaultTask(): TaskDef {
  return visibleTasks()[0] ?? active.tasks[0];
}
