import { describe, expect, it } from "vitest";
import { parseCategoryExtensions, newFacetSlotId } from "../categoryExtensions";
import { parseProfileFile } from "../file";
import { CATEGORY_ID_RE, NOVEL_PROFILE, type FacetSlot } from "../model";
import { resolveWorkspace } from "../resolve";

const slot: FacetSlot = { id: "user-motivation", labelZh: "动机", labelEn: "Motivation", expected: true, defaults: { mode: "manual", priority: 0 } };
const extensions = { characters: { slots: [slot] } };

describe("project category extensions", () => {
  it("parses v3 additions and custom-category slots without changing older files", () => {
    const parsed = parseProfileFile({ version: 3, enabled: ["novel"], categoryExtensions: extensions, categories: [{ id: "research", labelZh: "Research", labelEn: "Research", slots: [slot] }] });
    expect(parsed.issues).toEqual([]);
    expect(parsed.categoryExtensions).toEqual(extensions);
    expect(parsed.customCategories[0].slots).toEqual([slot]);
    expect(parseProfileFile({ version: 3, enabled: [] }).categoryExtensions).toBeUndefined();
  });

  it("adds slots without mutating built-ins or another project, and preserves image slots", () => {
    const original = JSON.stringify(NOVEL_PROFILE);
    const extended = resolveWorkspace([NOVEL_PROFILE], [], extensions);
    const category = extended.categories.find((c) => c.id === "characters")!;
    const baseline = resolveWorkspace([NOVEL_PROFILE]).categories.find((c) => c.id === "characters")!;
    expect(category.slots).toEqual([...(baseline.slots ?? []), slot]);
    expect(category.imageSlots).toEqual(baseline.imageSlots);
    expect(JSON.stringify(NOVEL_PROFILE)).toBe(original);
    expect(baseline.slots).not.toContainEqual(slot);
  });

  it("keeps extensions dormant without declaring orphan categories", () => {
    expect(resolveWorkspace([], [], extensions).categories.map((c) => c.id)).toEqual(["custom"]);
    expect(resolveWorkspace([NOVEL_PROFILE], [], extensions).categories.find((c) => c.id === "characters")?.slots).toContainEqual(slot);
    expect(resolveWorkspace([], [], { custom: { slots: [slot] } }).categories[0].slots).toEqual([slot]);
  });

  it("reports collisions case-insensitively and never overrides a pack slot", () => {
    const base = NOVEL_PROFILE.categories.find((c) => c.id === "characters")!.slots![0];
    const result = resolveWorkspace([NOVEL_PROFILE], [], { CHARACTERS: { slots: [{ ...slot, id: base.id.toUpperCase() }] } });
    expect(result.issues).toHaveLength(1);
    expect(result.categories.find((c) => c.id === "characters")?.slots?.[0]).toEqual(base);
  });

  it("validates ids, duplicates and the per-source limit without truncating merged lists", () => {
    const issues: string[] = [];
    const parsed = parseCategoryExtensions({ "../bad": { slots: [] }, Characters: { slots: [slot, { ...slot, id: slot.id.toUpperCase() }] }, characters: { slots: [slot] } }, issues);
    expect(issues).toHaveLength(3);
    expect(parsed).toEqual(extensions);
    const twelve = Array.from({ length: 12 }, (_, i) => ({ ...slot, id: `user-${i}` }));
    const merged = resolveWorkspace([NOVEL_PROFILE], [], { characters: { slots: twelve } });
    expect(merged.categories.find((c) => c.id === "characters")!.slots!.length).toBeGreaterThan(12);
    const over: string[] = [];
    parseCategoryExtensions({ characters: { slots: [...twelve, slot] } }, over);
    expect(over).toHaveLength(1);
  });

  it("generates valid stable-identity namespace ids", () => {
    const id = newFacetSlotId();
    expect(id).toMatch(CATEGORY_ID_RE);
    expect(id).toMatch(/^user-/);
    expect(newFacetSlotId()).not.toBe(id);
  });
});
