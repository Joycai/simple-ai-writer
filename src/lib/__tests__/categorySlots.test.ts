/**
 * Category type schemas — the `slots` / `imageSlots` a capability pack may
 * declare on one of its knowledge-base categories (docs/lore-entry-type-plan.md
 * phase 1).
 *
 * Three things are worth pinning down, and all three are quiet when broken:
 *   - a category with no schema keeps *no key at all*, so a plain category still
 *     compares and serialises exactly as it did before schemas existed;
 *   - two packs sharing a category id get the **union** of their slots, first
 *     declarer winning per id — enabling a second pack may add facets worth
 *     filling, never redefine one the category already had;
 *   - the merge never grows a built-in pack's own arrays, which are module-level
 *     singletons shared by every project opened in the session.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  BUILTIN_PROFILES,
  NOVEL_PROFILE,
  parseProfile,
  type FacetSlot,
  type WorkspaceProfile,
} from "../profile/model";
import { packsDeclaringCategory, resolveWorkspace } from "../profile/resolve";
import {
  categoryFacetSlots,
  categoryImageSlots,
  findFacetSlot,
  resetActiveWorkspace,
  setActiveWorkspace,
} from "../profile/active";

/** A minimal hand-written pack, the way a profile.json would carry one. */
const pack = (id: string, categories: unknown[]): unknown => ({ id, categories });

function parsePack(raw: unknown): { profile: WorkspaceProfile; issues: string[] } {
  return parseProfile(raw, NOVEL_PROFILE);
}

describe("parseCategory — schema validation", () => {
  it("parses slots with labels, hints, expected and defaults", () => {
    const { profile, issues } = parsePack(
      pack("x", [
        {
          id: "people",
          labelZh: "联系人",
          labelEn: "Contacts",
          slots: [
            {
              id: "role",
              labelZh: "职责",
              labelEn: "Role",
              hintZh: "负责什么、向谁汇报",
              expected: true,
              defaults: { mode: "always", priority: 3, group: "org", keys: ["职责", "汇报"] },
            },
            { id: "history", labelZh: "往来", labelEn: "History" },
          ],
          imageSlots: [{ id: "photo", labelZh: "照片", labelEn: "Photo", expected: true }],
        },
      ]),
    );
    expect(issues).toEqual([]);
    const cat = profile.categories[0];
    expect(cat.slots?.map((s) => s.id)).toEqual(["role", "history"]);
    expect(cat.slots?.[0]).toEqual({
      id: "role",
      labelZh: "职责",
      labelEn: "Role",
      hintZh: "负责什么、向谁汇报",
      expected: true,
      defaults: { mode: "always", priority: 3, group: "org", keys: ["职责", "汇报"] },
    });
    // Absent optionals stay absent rather than becoming null/false/empty.
    expect(cat.slots?.[1]).toEqual({ id: "history", labelZh: "往来", labelEn: "History" });
    expect(cat.imageSlots?.[0].expected).toBe(true);
  });

  it("leaves a schema-less category exactly as it was before schemas existed", () => {
    const { profile, issues } = parsePack(
      pack("x", [
        { id: "notes", labelZh: "笔记", labelEn: "Notes" },
        { id: "empty", labelZh: "空", labelEn: "Empty", slots: [], imageSlots: [] },
      ]),
    );
    expect(issues).toEqual([]);
    // No `slots: []` — an empty list is the same thing as no schema, and the
    // difference would show up in profile.json and in every deep comparison.
    expect(profile.categories[0]).toEqual({ id: "notes", labelZh: "笔记", labelEn: "Notes" });
    expect(profile.categories[1]).toEqual({ id: "empty", labelZh: "空", labelEn: "Empty" });
    expect("slots" in profile.categories[1]).toBe(false);
  });

  it("drops a slot with an unusable id and keeps the rest", () => {
    const { profile, issues } = parsePack(
      pack("x", [
        {
          id: "people",
          slots: [{ id: "../escape" }, { id: "a/b" }, { id: "" }, { id: "ok" }],
        },
      ]),
    );
    expect(profile.categories[0].slots?.map((s) => s.id)).toEqual(["ok"]);
    expect(issues.filter((i) => i.includes("not a valid slot id"))).toHaveLength(3);
    // An id-less slot still falls back to the id for its labels.
    expect(profile.categories[0].slots?.[0]).toEqual({ id: "ok", labelZh: "ok", labelEn: "ok" });
  });

  it("rejects case-insensitive duplicate slot ids and caps the list", () => {
    const { profile, issues } = parsePack(
      pack("x", [
        {
          id: "people",
          slots: [
            { id: "role", labelZh: "职责" },
            { id: "Role", labelZh: "重复" },
            ...Array.from({ length: 20 }, (_, i) => ({ id: `s${i}` })),
          ],
        },
      ]),
    );
    expect(issues).toContain('duplicate facet slot id "Role"');
    expect(issues.some((i) => i.includes("more than 12 facet slots"))).toBe(true);
    expect(profile.categories[0].slots).toHaveLength(12);
    expect(profile.categories[0].slots?.[0].labelZh).toBe("职责");
  });

  it("reports unusable defaults instead of inventing them", () => {
    const { profile, issues } = parsePack(
      pack("x", [
        {
          id: "people",
          slots: [
            { id: "a", defaults: { mode: "sometimes", priority: "soon", group: "   " } },
            { id: "b", defaults: { keys: "职责" } },
            { id: "c", defaults: {} },
            { id: "d", defaults: 7 },
          ],
        },
      ]),
    );
    const byId = new Map(profile.categories[0].slots!.map((s) => [s.id, s]));
    // Every field of the first slot was unusable, so it has no defaults at all
    // rather than a half-filled object with a made-up mode.
    expect(byId.get("a")?.defaults).toBeUndefined();
    expect(byId.get("b")?.defaults).toBeUndefined();
    expect(byId.get("c")?.defaults).toBeUndefined();
    expect(byId.get("d")?.defaults).toBeUndefined();
    expect(issues.some((i) => i.includes('defaults.mode must be one of'))).toBe(true);
    expect(issues.some((i) => i.includes('defaults.priority must be a number'))).toBe(true);
    expect(issues.some((i) => i.includes('defaults.group is not a usable'))).toBe(true);
    expect(issues.some((i) => i.includes('defaults.keys is not an array'))).toBe(true);
    expect(issues.some((i) => i.includes('"d" defaults is not an object'))).toBe(true);
  });

  it("caps and dedupes a slot's suggested keys", () => {
    const { profile, issues } = parsePack(
      pack("x", [
        {
          id: "people",
          slots: [{
            id: "a",
            defaults: { keys: ["k", "k", " k ", "", "a", "b", "c", "d", "e", "f", "g", "h", "i"] },
          }],
        },
      ]),
    );
    // Repeats and blanks don't consume the budget — eight *usable* keys survive.
    expect(profile.categories[0].slots?.[0].defaults?.keys)
      .toEqual(["k", "a", "b", "c", "d", "e", "f", "g"]);
    expect(issues.some((i) => i.includes("more than 8 default keys"))).toBe(true);
  });

  it("complains about a non-boolean expected and a non-array slot list", () => {
    const { profile, issues } = parsePack(
      pack("x", [
        { id: "a", slots: [{ id: "s", expected: "yes" }] },
        { id: "b", slots: { id: "s" } },
      ]),
    );
    expect(profile.categories[0].slots?.[0].expected).toBeUndefined();
    expect(issues).toContain('facet slot "s" expected must be true or false');
    expect(issues).toContain("facet slots is not an array");
    expect(profile.categories[1].slots).toBeUndefined();
  });
});

describe("resolveWorkspace — schema merge", () => {
  const slot = (id: string, labelZh: string): FacetSlot => ({ id, labelZh, labelEn: id });
  const withSlots = (id: string, catId: string, slots: FacetSlot[]): WorkspaceProfile => ({
    id,
    labelZh: id,
    labelEn: id,
    categories: [{ id: catId, labelZh: catId, labelEn: catId, slots }],
    tasks: [],
    sections: {},
  });

  it("carries a single pack's schema through", () => {
    const w = resolveWorkspace([NOVEL_PROFILE]);
    const characters = w.categories.find((c) => c.id === "characters")!;
    expect(characters.slots?.map((s) => s.id)).toContain("appearance");
    expect(characters.imageSlots?.map((s) => s.id)).toContain("portrait");
    // The misc bucket and every schema-less category keep no schema key.
    expect(w.categories.find((c) => c.id === "custom")!.slots).toBeUndefined();
    expect(w.categories.find((c) => c.id === "style")!.slots).toBeUndefined();
  });

  it("unions slots of a shared category, first declarer winning per id", () => {
    const a = withSlots("a", "factions", [slot("structure", "组织架构"), slot("members", "成员")]);
    const b = withSlots("b", "factions", [slot("structure", "架构（B 的说法）"), slot("mood", "阵营态度")]);
    const w = resolveWorkspace([a, b]);
    const factions = w.categories.find((c) => c.id === "factions")!;
    expect(factions.slots?.map((s) => s.id)).toEqual(["structure", "members", "mood"]);
    expect(factions.slots?.[0].labelZh).toBe("组织架构");
    expect(factions.packIds).toEqual(["a", "b"]);
  });

  it("gives a schema to a shared category that the first declarer left plain", () => {
    const plain: WorkspaceProfile = {
      id: "plain", labelZh: "plain", labelEn: "plain",
      categories: [{ id: "factions", labelZh: "势力", labelEn: "Factions" }],
      tasks: [], sections: {},
    };
    const w = resolveWorkspace([plain, withSlots("b", "factions", [slot("mood", "阵营态度")])]);
    expect(w.categories.find((c) => c.id === "factions")!.slots?.map((s) => s.id)).toEqual(["mood"]);
  });

  it("never grows a built-in pack's own arrays", () => {
    const before = NOVEL_PROFILE.categories.find((c) => c.id === "factions")!.slots!.length;
    const extra = withSlots("extra", "factions", [slot("mood", "阵营态度")]);
    const w = resolveWorkspace([NOVEL_PROFILE, extra]);
    expect(w.categories.find((c) => c.id === "factions")!.slots).toHaveLength(before + 1);
    // The singleton every other project in this session shares is untouched.
    expect(NOVEL_PROFILE.categories.find((c) => c.id === "factions")!.slots).toHaveLength(before);
    // …and resolving again is not cumulative.
    expect(
      resolveWorkspace([NOVEL_PROFILE, extra]).categories.find((c) => c.id === "factions")!.slots,
    ).toHaveLength(before + 1);
  });

  it("leaves a user-defined category without a schema", () => {
    const w = resolveWorkspace([], [{ id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" }]);
    expect(w.categories.find((c) => c.id === "meetings")!.slots).toBeUndefined();
  });
});

describe("active accessors — and what a disabled pack degrades to", () => {
  beforeEach(() => resetActiveWorkspace());

  it("answers with the active workspace's schema", () => {
    expect(categoryFacetSlots("characters").map((s) => s.id)).toContain("appearance");
    expect(categoryImageSlots("characters").map((s) => s.id)).toContain("portrait");
    expect(findFacetSlot("characters", "appearance")?.labelZh).toBe("外貌");
    // Slot ids are matched the way the merge dedupes them.
    expect(findFacetSlot("characters", " APPEARANCE ")?.id).toBe("appearance");
  });

  it("returns empty for an unknown category, an unknown slot, and a blank id", () => {
    expect(categoryFacetSlots("npcs")).toEqual([]);
    expect(categoryImageSlots("npcs")).toEqual([]);
    expect(findFacetSlot("characters", "no-such-slot")).toBeNull();
    expect(findFacetSlot("characters", "  ")).toBeNull();
  });

  it("degrades to no schema when the declaring pack is disabled", () => {
    // The entries and their `slot:` frontmatter are untouched on disk; all the
    // author loses is the grouping. Nothing here may report an error state.
    setActiveWorkspace(resolveWorkspace([]));
    expect(categoryFacetSlots("characters")).toEqual([]);
    expect(findFacetSlot("characters", "appearance")).toBeNull();
    // Re-enabling restores it, which is why a scan must never rewrite the value.
    setActiveWorkspace(resolveWorkspace([NOVEL_PROFILE]));
    expect(findFacetSlot("characters", "appearance")?.id).toBe("appearance");
  });
});

/**
 * `packsDeclaringCategory` — who would give an orphan category its type back
 * (设计稿 03 屏 23's banner and its one button).
 */
describe("packsDeclaringCategory", () => {
  it("finds the disabled pack that declares a category", () => {
    const ttrpg = BUILTIN_PROFILES.find((p) => p.id === "ttrpg")!;
    expect(packsDeclaringCategory("npcs", BUILTIN_PROFILES).map((p) => p.id)).toEqual(["ttrpg"]);
    expect(packsDeclaringCategory("NPCS", [ttrpg])).toEqual([ttrpg]);
    // A shared category legitimately has several declarers; the banner names the
    // first, which is the merge's own tie-break.
    expect(packsDeclaringCategory("items", BUILTIN_PROFILES).map((p) => p.id))
      .toEqual(["novel", "ttrpg"]);
  });

  it("finds nothing for a folder no pack ever declared", () => {
    expect(packsDeclaringCategory("meetings", BUILTIN_PROFILES)).toEqual([]);
    expect(packsDeclaringCategory("  ", BUILTIN_PROFILES)).toEqual([]);
  });
});
