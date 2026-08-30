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
  /**
   * Which **image slot** of the category's type schema this picture fills
   * (人设图 / 建筑图 / 概念图), from the block's `slot:` line; null when
   * unclassified. Presentation only — like a facet's slot, nothing on the
   * injection path reads it, so an id no enabled pack declares simply groups
   * under 未归类 until that pack is back.
   */
  slot: string | null;
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
   * docs/feature/lore/lore-entry-type-plan.md §4.
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
  /**
   * Frontmatter `dict: true` — this entry is a **translation dictionary**: its
   * body holds `原文->译文 #备注` lines that feed the JA→ZH glossary
   * (`lib/translate/glossary.isDictEntity`). An explicit author-set switch in
   * the entity editor, deliberately not a name/format heuristic. Absent =
   * false.
   */
  dict?: boolean;
  /**
   * 这条属于哪些**集合** —— 知识库的第二根轴，与分类正交，一条可属于任意多个
   * （见 lib/lore/collections）。frontmatter `collections`，缺席即空数组
   * ＝「未归集」，这也是集合出现之前所有条目的状态。
   *
   * 和 `dict` 一样是显式的作者开关，不是从名字或分类猜出来的。
   */
  collections: string[];
  /**
   * 阅读模式档案头大图指向的图库文件名，frontmatter `cover`（设计稿 16 屏
   * 1z/1f 的「主图」）。作者在 lightbox 里显式指定；缺席时阅读模式取第一个
   * 配图组的第一张。指向的文件不在图库里时按缺席处理——图删了封面就静默退回
   * 缺省，绝不报错。展示专用：注入路径一个字都不读它。
   */
  cover?: string | null;
  mdFiles: string[];   // list of *.md filenames in the folder
  /** Parsed from images.md (each `## filename` heading + following paragraph). */
  images: LoreImage[];
  /** Facet metadata parsed from sibling md frontmatter (content loads lazily). */
  facets: LoreFacet[];
  /**
   * The `[[lore:…]]` targets this entry's own prose cites — index.md and every
   * facet body, deduplicated, **unresolved** (see `collectCiteTargets`).
   *
   * The author writing `[[lore:星辉之杖]]` inside a character is an explicit
   * declaration that the two belong together, and it is worth more than any
   * similarity score: it survives the staff never being named in the passage
   * being written, which is exactly the case substring matching cannot reach
   * (docs/feature/lore/lore-retrieval-plan.md §4).
   *
   * Raw targets, not paths — resolution needs the finished index, and a name
   * survives the entry moving between categories where a path would not.
   *
   * Optional for the same reason `dict` is: `scanLore` always fills it, but
   * entities also arrive from hand-built fixtures and from callers that only
   * need identity. Absent reads as "no citations", which is the honest answer
   * for an entity nobody scanned.
   */
  refs?: string[];
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
 * itself, and so are the six arrays they splice or reassign. Facet and image
 * objects are only ever replaced wholesale, so they stay shared.
 *
 * Hand-written rather than `structuredClone`: this has to work in every
 * webview and in jsdom, and the shape is small and known.
 *
 * The six arrays are defaulted rather than assumed. `scanLore` always fills
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
      collections: [...(e.collections ?? [])],
      mdFiles: [...(e.mdFiles ?? [])],
      facets: [...(e.facets ?? [])],
      images: [...(e.images ?? [])],
      refs: [...(e.refs ?? [])],
    }));
  }
  return out;
}

export interface EntityMeta {
  name: string;
  aliases: string[];
  category: CategoryId;
  summary: string;
  /**
   * Translation-dictionary switch (see `LoreEntity.dict`). Optional so plain
   * metadata writers compile, but every caller saving an **existing** entity
   * must carry `entity.dict` through — omitting it silently un-marks the
   * dictionary on the next save, the same trap `FacetMeta.slot` documents.
   */
  dict?: boolean;
  /**
   * 集合归属（见 `LoreEntity.collections`）。
   *
   * 和 `dict` 不同，这个字段**缺席即「保持原样」**：`saveEntityMetaAndBody` 从它
   * 手上那份 entity 补默认值。`dict` 那条「每个写入方都得自己带上」的纪律有六个
   * 写入点要守，与其再加一条同样的纪律，不如让默认值本身正确——真要清空归属就显式
   * 传 `[]`，那和 undefined 是分得开的。
   */
  collections?: string[];
  /**
   * 档案头大图（见 `LoreEntity.cover`）。同 `collections` 的纪律：**缺席即
   * 「保持原样」**（`saveEntityMetaAndBody` 补默认值），清除是显式的 `null`。
   */
  cover?: string | null;
}
