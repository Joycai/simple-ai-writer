/**
 * `lib/lore/slots` — the authoring side of a category's type schema
 * (docs/lore-entry-type-plan.md phase 3).
 *
 * What is worth pinning: an entry knows which of its category's slots are
 * covered and which are expected-and-empty; a slot value nothing declares is
 * *unclassified*, never an error and never rewritten; and slot defaults are
 * materialised into a new facet's metadata without overwriting anything the
 * model or the author actually decided.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { slotChecklistText, slotStatuses, unslottedFacets, withSlotDefaults } from "../lore/slots";
import type { FacetMeta, LoreEntity, LoreFacet } from "../lore/model";
import { NOVEL_PROFILE, resetActiveWorkspace, resolveWorkspace, setActiveWorkspace } from "../profile";

const facet = (partial: Partial<LoreFacet> & { file: string; title: string }): LoreFacet => ({
  slot: null, keys: [], group: null, priority: 0, mode: "auto", charCount: 0, ...partial,
});

const entity = (category: string, facets: LoreFacet[]): LoreEntity => ({
  id: "aria", category, dirPath: `/p/.ai-writer/lore/${category}/aria`, name: "Aria",
  aliases: [], summary: "", avatarPath: null, mdFiles: [], images: [], facets,
});

const meta = (partial: Partial<FacetMeta> = {}): FacetMeta => ({
  title: "F", keys: [], group: null, priority: 0, mode: "auto", ...partial,
});

beforeEach(() => resetActiveWorkspace()); // the novel pack alone

describe("slotStatuses", () => {
  it("reports what covers each slot, and which expected ones are empty", () => {
    const e = entity("characters", [
      facet({ file: "look.md", title: "外貌", slot: "appearance" }),
      facet({ file: "armor.md", title: "战甲形象", slot: "OUTFIT" }),
      facet({ file: "casual.md", title: "便装形象", slot: "outfit" }),
      facet({ file: "notes.md", title: "杂记" }),
    ]);
    const byId = new Map(slotStatuses(e).map((s) => [s.slot.id, s]));

    expect(byId.get("appearance")!.facets.map((f) => f.title)).toEqual(["外貌"]);
    // Matched case-insensitively, the same way the schema merge dedupes ids.
    expect(byId.get("outfit")!.facets.map((f) => f.title)).toEqual(["战甲形象", "便装形象"]);
    expect(byId.get("appearance")!.missing).toBe(false);
    // `relations` is declared `expected` and nothing fills it.
    expect(byId.get("relations")!.missing).toBe(true);
    // A slot that is empty but not expected is not "missing" — no nudge for it.
    expect(byId.get("backstory")!.missing).toBe(false);
  });

  it("is empty for a category with no schema — an ordinary entry, not an error", () => {
    expect(slotStatuses(entity("custom", [facet({ file: "a.md", title: "A" })]))).toEqual([]);
    // Same answer when the declaring pack is disabled: the entry degrades.
    setActiveWorkspace(resolveWorkspace([]));
    expect(slotStatuses(entity("characters", []))).toEqual([]);
  });
});

describe("unslottedFacets", () => {
  it("buckets a missing slot and an undeclarable one together", () => {
    const e = entity("characters", [
      facet({ file: "look.md", title: "外貌", slot: "appearance" }),
      facet({ file: "notes.md", title: "杂记" }),
      facet({ file: "gm.md", title: "GM 提示", slot: "stats" }), // a TTRPG slot
    ]);
    // Both are "unclassified right now", and the second fixes itself when the
    // pack that declares `stats` comes back — nothing here rewrites the value.
    expect(unslottedFacets(e).map((f) => f.title)).toEqual(["杂记", "GM 提示"]);
    expect(e.facets[2].slot).toBe("stats");
  });
});

describe("slotChecklistText", () => {
  it("lists ids, labels, hints, defaults and coverage", () => {
    const text = slotChecklistText(entity("characters", [
      facet({ file: "armor.md", title: "战甲形象", slot: "outfit" }),
      facet({ file: "notes.md", title: "杂记" }),
    ]));
    expect(text).toContain('FACET SLOTS for category "characters"');
    // The id is the token the model has to echo back, so it leads every line.
    expect(text).toMatch(/- appearance \(外貌 \/ Appearance\) \[expected\]/);
    expect(text).toContain("already covered by: 战甲形象");
    expect(text).toContain("EXPECTED BUT MISSING");
    expect(text).toContain("defaults: group=outfit");
    expect(text).toContain("mode=always"); // the voice slot's default
    expect(text).toContain("(unclassified facets, no slot: 杂记)");
  });

  it("renders nothing when the category has no schema", () => {
    // Callers concatenate this into a prompt, so "nothing to say" must be "".
    expect(slotChecklistText(entity("custom", []))).toBe("");
  });
});

describe("withSlotDefaults", () => {
  it("fills only the fields still at their neutral value", () => {
    // `voice` declares mode=always; nothing else.
    const filled = withSlotDefaults(meta({ slot: "voice" }), "characters");
    expect(filled.mode).toBe("always");
    // An explicit non-neutral choice wins over the default.
    expect(withSlotDefaults(meta({ slot: "voice", mode: "manual" }), "characters").mode).toBe("manual");
    // `outfit` declares group=outfit.
    expect(withSlotDefaults(meta({ slot: "outfit" }), "characters").group).toBe("outfit");
    expect(withSlotDefaults(meta({ slot: "outfit", group: "form" }), "characters").group).toBe("form");
  });

  it("normalises the slot id to the declared casing", () => {
    // The value goes into the file; the schema's spelling is the one that groups.
    expect(withSlotDefaults(meta({ slot: " OUTFIT " }), "characters").slot).toBe("outfit");
  });

  it("leaves a facet alone without a slot, without defaults, or without a schema", () => {
    const bare = meta();
    expect(withSlotDefaults(bare, "characters")).toBe(bare);
    // `appearance` declares no defaults — same object back, nothing invented.
    const noDefaults = meta({ slot: "appearance" });
    expect(withSlotDefaults(noDefaults, "characters")).toBe(noDefaults);
    // A slot the category doesn't declare is left as the author wrote it.
    const foreign = meta({ slot: "stats" });
    expect(withSlotDefaults(foreign, "characters")).toBe(foreign);
    setActiveWorkspace(resolveWorkspace([]));
    const orphaned = meta({ slot: "outfit" });
    expect(withSlotDefaults(orphaned, "characters")).toBe(orphaned);
  });

  it("keeps suggested keys out of the way of the model's own", () => {
    setActiveWorkspace(resolveWorkspace([NOVEL_PROFILE]));
    // The TTRPG `stats` slot suggests keys; novel's slots mostly don't, so use a
    // pack-shaped check: keys given by the caller are never replaced.
    const given = withSlotDefaults(meta({ slot: "outfit", keys: ["战甲"] }), "characters");
    expect(given.keys).toEqual(["战甲"]);
  });
});
