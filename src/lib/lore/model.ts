/**
 * Lore domain model: category catalogue and the entity/index types shared by
 * the scanner, gallery helpers, generator, and UI.
 */

export const LORE_CATEGORIES = [
  { id: "characters", labelZh: "人物",   labelEn: "Characters", icon: "user" },
  { id: "world",      labelZh: "世界观", labelEn: "World",      icon: "globe" },
  { id: "factions",   labelZh: "势力",   labelEn: "Factions",   icon: "shield" },
  { id: "items",      labelZh: "道具",   labelEn: "Items",      icon: "package" },
  { id: "skills",     labelZh: "技能",   labelEn: "Skills",     icon: "zap" },
  { id: "style",      labelZh: "风格",   labelEn: "Style",      icon: "feather" },
  { id: "custom",     labelZh: "自定义", labelEn: "Custom",     icon: "grid" },
] as const;

export type CategoryId = (typeof LORE_CATEGORIES)[number]["id"];

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

/** Editable facet metadata — what the facet form reads and writes. */
export interface FacetMeta {
  title: string;
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

export interface EntityMeta {
  name: string;
  aliases: string[];
  category: CategoryId;
  summary: string;
}
