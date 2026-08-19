/**
 * Facet slots at work — the entity-side view of a category's type schema
 * (`ProfileCategory.slots`, see docs/lore-entry-type-plan.md).
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

import { categoryFacetSlots, findFacetSlot } from "../profile/active";
import type { FacetSlot } from "../profile/model";
import type { FacetMeta, LoreEntity, LoreFacet } from "./model";

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
