/**
 * Lore domain model: the entity/index types shared by the scanner, gallery
 * helpers, generator, and UI.
 *
 * The category *catalogue* is not here — it belongs to the active workspace
 * profile (`lib/profile`), because which categories exist depends on what the
 * project is (a novel has 人物/世界观, a TTRPG module has NPC/地点/规则).
 * Call `loreCategories()` to enumerate them and `isKnownCategory()` to validate
 * one.
 */

/**
 * A category id, which is also the folder name under `.ai-writer/lore/`.
 *
 * Deliberately a plain string rather than a union of the built-in ids: the set
 * is profile-defined and therefore only knowable at runtime. Anything that
 * turns an id from disk, the author, or the model into a path must validate it
 * with `isKnownCategory()` — the type can no longer do that job.
 */
export type CategoryId = string;

export interface LoreImage {
  /** File name relative to the entity directory. */
  file: string;
  /** Plain-text description, shown to text-only models and rendered in the gallery. */
  desc: string;
  /** Absolute path on disk (populated by scanLore). */
  absPath: string;
}

/**
 * A facet is an independently-activatable slice of an entity — an outfit, a
 * backstory arc, a relationship — stored as a plain `.md` file inside the
 * entity directory whose frontmatter carries a `facet` field. Files without
 * that field remain inert attachments (backwards compatible).
 *
 * Activation model (see src/lib/context/loreSelect.ts):
 *   auto   — injected when the entity matches AND any of `keys` appears in
 *            the match target (secondary-key AND logic)
 *   always — injected whenever the entity matches
 *   manual — only injected when explicitly pinned
 */
export interface LoreFacet {
  /** Filename within the entity dir, e.g. "outfit-armor.md". */
  file: string;
  /** Display name from frontmatter `facet`. */
  title: string;
  /**
   * Which **slot** of the category's type schema this facet fills (外貌,
   * 组织架构…), from frontmatter `slot`; null when unclassified.
   *
   * Metadata only — the injection engine never reads it, so a value naming a
   * slot no enabled pack declares is simply unclassified *for now* and is kept
   * verbatim: the pack coming back must restore the grouping, which a scan that
   * "cleaned up" the value could not do. See `findFacetSlot` and
   * docs/lore-entry-type-plan.md §4.
   */
  slot: string | null;
  /** Secondary activation keywords. Empty + mode "auto" ⇒ never auto-fires. */
  keys: string[];
  /** Mutual-exclusion group (scoped to the entity); null = ungrouped. */
  group: string | null;
  /** Higher wins within a group and fills budget earlier. Default 0. */
  priority: number;
  mode: "auto" | "always" | "manual";
  /** Body length in chars (frontmatter excluded), for UI token estimates. */
  charCount: number;
}

/** Entity-dir filenames that can never be facets. */
export const RESERVED_ENTITY_FILES = ["index.md", "images.md"];

/**
 * Editable facet metadata — what the facet form reads and writes.
 *
 * `slot` is optional here while `LoreFacet.slot` is not: parsing always has an
 * answer, whereas a writer may not care. Every writer must still *carry it
 * through* rather than omitting it — dropping the field silently unclassifies
 * the facet on the next save.
 */
export interface FacetMeta {
  title: string;
  slot?: string | null;
  keys: string[];
  group: string | null;
  priority: number;
  mode: "auto" | "always" | "manual";
}

export interface LoreEntity {
  id: string;          // dir name, e.g. "elden"
  category: CategoryId;
  dirPath: string;     // absolute path to entity folder
  name: string;        // from index.md frontmatter
  aliases: string[];   // from frontmatter
  summary: string;     // from frontmatter
  avatarPath: string | null;  // abs path if avatar.png/jpg exists
  mdFiles: string[];   // list of *.md filenames in the folder
  /** Parsed from images.md (each `## filename` heading + following paragraph). */
  images: LoreImage[];
  /** Facet metadata parsed from sibling md frontmatter (content loads lazily). */
  facets: LoreFacet[];
}

export interface LoreIndex {
  [category: string]: LoreEntity[];
}

/**
 * Total entities across every category.
 *
 * Worth a named helper because the obvious `Object.keys(index).length` is
 * wrong and looks right: `scanLore` seeds `index[cat.id] = []` for *every*
 * category, so counting keys counts categories and never moves as entities are
 * added. The sidebar shipped that bug against a rail badge that had it right.
 */
export function loreEntityCount(index: LoreIndex): number {
  return Object.values(index).reduce((n, list) => n + list.length, 0);
}

/**
 * A detached copy for an agent run to mutate.
 *
 * A run's `ToolContext.loreIndex` is patched in place by the lore write tools
 * (see `agent/writeTools`), and the object a caller hands in is the live
 * `loreStore` state object — mutating that would edit store state behind
 * zustand's back, on arrays React is rendering from. Entities are copied too,
 * because those patches rewrite `id`/`dirPath`/`category` on the entity
 * itself, and so are the four arrays they splice or reassign. Facet and image
 * objects are only ever replaced wholesale, so they stay shared.
 *
 * Hand-written rather than `structuredClone`: this has to work in every
 * webview and in jsdom, and the shape is small and known.
 *
 * The four arrays are defaulted rather than assumed. `scanLore` always fills
 * them, but entities also arrive from hand-built fixtures and callers that
 * only need identity — the same reason `readLoreEntity` guards `mdFiles?.length`
 * — and a clone is the wrong place to start throwing about it.
 */
export function cloneLoreIndex(index: LoreIndex): LoreIndex {
  const out: LoreIndex = {};
  for (const [category, list] of Object.entries(index)) {
    out[category] = list.map((e) => ({
      ...e,
      aliases: [...(e.aliases ?? [])],
      mdFiles: [...(e.mdFiles ?? [])],
      facets: [...(e.facets ?? [])],
      images: [...(e.images ?? [])],
    }));
  }
  return out;
}

export interface EntityMeta {
  name: string;
  aliases: string[];
  category: CategoryId;
  summary: string;
}
