/**
 * Facet slots at work — the entity-side view of a category's type schema
 * (`ProfileCategory.slots`, see docs/feature/lore/lore-entry-type-plan.md).
 *
 * The schema itself is workspace data; this module answers the questions the
 * *authoring* side asks about one entry: which slots does its category declare,
 * what fills each one, what is expected and still missing, and what a newly
 * created facet of a slot starts out as.
 *
 * Two rules hold everything here together, and both are load-bearing:
 *
 *   1. **Nothing here reaches injection.** `selectLore` reads a facet's own
 *      frontmatter (`keys`/`group`/`priority`/`mode`) and never a slot, so a
 *      workspace whose pack got disabled loses the grouping and the nudges and
 *      changes what the model sees by not one character.
 *   2. **Defaults are materialised at creation, never resolved at read time**
 *      (`withSlotDefaults`). A facet on disk therefore always carries its full
 *      injection semantics, which is what makes rule 1 survivable.
 */

import { categoryFacetSlots, categoryImageSlots, findCategory, findFacetSlot } from "../profile/active";
import { categoryLabel, type FacetSlot, type ImageSlot } from "../profile/model";
import type { FacetMeta, LoreEntity, LoreFacet, LoreImage } from "./model";

/**
 * `novel/人物` — the pack that declares this category, then the category's own
 * label. What the detail pane calls the entry's **type**.
 *
 * The pack **id** rather than its label because it is the short stable token the
 * author sees everywhere else a pack is named (Settings → 工作台, profile.json),
 * and because the label ("小说") reads as a genre next to a category name.
 *
 * Null when no *enabled* pack declares the category: a user-defined category,
 * the `custom` bucket, or an orphan. An orphan's type still has a name, but only
 * a disabled pack can supply it — that lookup is `packsDeclaringCategory`, and
 * it belongs to the surface that also says the pack is off (设计稿 03 屏 23).
 */
export function categoryTypeName(category: string, isZh: boolean): string | null {
  const resolved = findCategory(category);
  const packId = resolved?.packIds[0];
  if (!resolved || !packId) return null;
  return `${packId}/${categoryLabel(resolved, isZh)}`;
}

/** One declared slot plus what the entry currently has in it. */
export interface SlotStatus {
  slot: FacetSlot;
  /** Facets whose `slot` names this one (matched case-insensitively). */
  facets: LoreFacet[];
  /** Declared `expected` and nothing fills it — the nudge's condition. */
  missing: boolean;
}

/**
 * The entry's slots in declaration order. Empty when its category has no
 * schema — a user-defined category, the `custom` bucket, or a category whose
 * declaring pack is disabled. Empty means "an ordinary entry", never an error.
 */
export function slotStatuses(entity: LoreEntity): SlotStatus[] {
  const facets = entity.facets ?? [];
  return categoryFacetSlots(entity.category).map((slot) => {
    const key = slot.id.toLowerCase();
    const filled = facets.filter((f) => (f.slot ?? "").toLowerCase() === key);
    return { slot, facets: filled, missing: slot.expected === true && filled.length === 0 };
  });
}

/**
 * Facets that belong to no slot of the active schema — either carrying no
 * `slot` at all or one nothing currently declares.
 *
 * Deliberately one bucket rather than two: for every consumer (a grouped list,
 * a prompt checklist) both mean the same thing — *unclassified right now* — and
 * the distinction is not the author's to act on, since the second case fixes
 * itself when the pack comes back.
 */
export function unslottedFacets(entity: LoreEntity): LoreFacet[] {
  return (entity.facets ?? []).filter(
    (f) => !f.slot || !findFacetSlot(entity.category, f.slot),
  );
}

/**
 * One section of the detail pane's facet column: a declared slot with the facets
 * that fill it, then one final `slot: null` section for everything unclassified.
 *
 * `missing` marks a section the author is *invited* to fill — declared
 * `expected`, currently empty. It is a nudge, so nothing about it blocks or
 * warns: 设计稿 03 屏 20 draws it as a dashed row, not an error.
 */
export interface FacetSection {
  slot: FacetSlot | null;
  facets: LoreFacet[];
  missing: boolean;
}

/**
 * Group an entry's facets into sections, in schema order, with the unclassified
 * ones last.
 *
 * Returns `[]` when the category has no schema — the caller then renders the
 * flat list it always did, which *is* the degraded presentation (屏 23). An
 * empty array rather than one all-encompassing section, so "no schema" and
 * "schema with nothing classified yet" stay distinguishable at the call site.
 */
export function facetSections(entity: LoreEntity): FacetSection[] {
  const statuses = slotStatuses(entity);
  if (statuses.length === 0) return [];
  const sections: FacetSection[] = statuses.map(({ slot, facets, missing }) => ({
    slot,
    facets,
    missing,
  }));
  const loose = unslottedFacets(entity);
  if (loose.length > 0) sections.push({ slot: null, facets: loose, missing: false });
  return sections;
}

/** How much of the type's suggestion an entry has taken up (屏 20's mono note). */
export interface SlotCoverage {
  /** Slots the category declares. */
  total: number;
  /** Of those, how many have at least one facet. */
  covered: number;
  /** The `expected` ones still empty — what the note names. */
  missing: FacetSlot[];
}

export function slotCoverage(entity: LoreEntity): SlotCoverage {
  const statuses = slotStatuses(entity);
  return {
    total: statuses.length,
    covered: statuses.filter((s) => s.facets.length > 0).length,
    missing: statuses.filter((s) => s.missing).map((s) => s.slot),
  };
}

/** The image column's counterpart to `FacetSection` (屏 22). */
export interface ImageSection {
  slot: ImageSlot | null;
  images: LoreImage[];
  missing: boolean;
}

/**
 * Group an entry's gallery by image slot, same contract as `facetSections`:
 * schema order, unclassified last, `[]` when the category declares no image
 * slots (then the column stays the flat list it was).
 */
export function imageSections(entity: LoreEntity): ImageSection[] {
  const slots = categoryImageSlots(entity.category);
  if (slots.length === 0) return [];
  const images = entity.images ?? [];
  const declared = new Set(slots.map((s) => s.id.toLowerCase()));
  const sections: ImageSection[] = slots.map((slot) => {
    const key = slot.id.toLowerCase();
    const filled = images.filter((i) => (i.slot ?? "").toLowerCase() === key);
    return { slot, images: filled, missing: slot.expected === true && filled.length === 0 };
  });
  const loose = images.filter((i) => !i.slot || !declared.has(i.slot.toLowerCase()));
  if (loose.length > 0) sections.push({ slot: null, images: loose, missing: false });
  return sections;
}

/** `id (中文 / English)` — the model may be writing in either language, and the
 *  id is the one token it has to echo back. */
function slotHeading(slot: FacetSlot): string {
  const labels = slot.labelZh === slot.labelEn ? slot.labelZh : `${slot.labelZh} / ${slot.labelEn}`;
  return `${slot.id} (${labels})`;
}

/** `defaults: mode=always, group=outfit` — only what the slot actually declares. */
function slotDefaultsNote(slot: FacetSlot): string {
  const d = slot.defaults;
  if (!d) return "";
  const parts: string[] = [];
  if (d.mode) parts.push(`mode=${d.mode}`);
  if (d.group) parts.push(`group=${d.group}`);
  if (d.priority !== undefined) parts.push(`priority=${d.priority}`);
  if (d.keys?.length) parts.push(`suggested keys: ${d.keys.join(", ")}`);
  return parts.length ? ` · defaults: ${parts.join(", ")}` : "";
}

/**
 * The model-facing checklist for one entry: which slots its category declares,
 * which are already covered, which are expected and still empty.
 *
 * Returns `""` when the category has no schema, because every caller
 * concatenates this into a prompt — "nothing to say" has to render as nothing
 * rather than as a heading with an empty list under it.
 *
 * Bilingual labels rather than the UI language: this text is read by a model
 * that may be writing in either language, and picking one would also drag i18n
 * into a module the tests want to call as a pure function.
 */
export function slotChecklistText(entity: LoreEntity): string {
  const statuses = slotStatuses(entity);
  if (statuses.length === 0) return "";

  const lines = statuses.map(({ slot, facets, missing }) => {
    const hint = slot.hintZh || slot.hintEn ? ` — ${[slot.hintZh, slot.hintEn].filter(Boolean).join(" / ")}` : "";
    const state = facets.length
      ? ` · already covered by: ${facets.map((f) => f.title).join(", ")}`
      : missing
        ? " · EXPECTED BUT MISSING"
        : " · empty";
    return `- ${slotHeading(slot)}${slot.expected ? " [expected]" : ""}${hint}${slotDefaultsNote(slot)}${state}`;
  });

  const loose = unslottedFacets(entity);
  if (loose.length > 0) {
    lines.push(`- (unclassified facets, no slot: ${loose.map((f) => f.title).join(", ")})`);
  }

  return [
    `FACET SLOTS for category "${entity.category}" — the aspects entries of this category are expected to have.`,
    "Pass the slot id as the `slot` argument of a facet; omit it when a facet genuinely fits none of them.",
    ...lines,
  ].join("\n");
}

/**
 * Materialise a slot's defaults into a **new** facet's metadata.
 *
 * Only fields still at their neutral value are filled — empty `keys`, null
 * `group`, `priority` 0, `mode` "auto" — so anything the model or the author
 * actually decided survives. That does mean an explicit `mode: "auto"` is
 * indistinguishable from "not decided": a caller whose model chooses the mode
 * on purpose should not run its answer through here (the split flow does,
 * because `mode` is not one of the fields its tool exposes at all; the
 * draft-a-facet flow does not, because its model picks the mode itself and is
 * told the slot's suggestion in the prompt).
 *
 * Called once, when the file is created. Nothing resolves defaults on read:
 * that is invariant two, and it is why disabling a pack can't change injection.
 */
export function withSlotDefaults(meta: FacetMeta, category: string): FacetMeta {
  if (!meta.slot) return meta;
  const slot = findFacetSlot(category, meta.slot);
  const defaults = slot?.defaults;
  if (!defaults) return meta;
  return {
    ...meta,
    // The slot id is normalised to the declared casing on the way in, so the
    // file on disk matches the schema even if the model shouted it.
    slot: slot.id,
    keys: meta.keys.length === 0 && defaults.keys?.length ? [...defaults.keys] : meta.keys,
    group: meta.group === null && defaults.group ? defaults.group : meta.group,
    priority: meta.priority === 0 && defaults.priority !== undefined ? defaults.priority : meta.priority,
    mode: meta.mode === "auto" && defaults.mode ? defaults.mode : meta.mode,
  };
}
