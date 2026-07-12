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
