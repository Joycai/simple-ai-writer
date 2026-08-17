/**
 * profile.json's three generations (lib/profile/file).
 *
 * The v1 branch is the compatibility surface: every project created before
 * packs existed reads through it, so it must keep resolving to "that pack,
 * alone". The v2 branch reads the retired primary as nothing more than
 * ordering. v3 is the current format: equal packs plus the project's
 * user-defined categories. All branches arbitrate hand-editable data, so like
 * parseProfile they drop what they can't use, loudly, and never throw.
 */
import { describe, expect, it } from "vitest";
import { parseProfileFile } from "../profile/file";
import {
  BID_PROFILE,
  NOVEL_PROFILE,
  TTRPG_PROFILE,
} from "../profile/model";

describe("v1 files", () => {
  it("resolves a bare builtin id to that builtin, alone, with no custom pack", () => {
    const sel = parseProfileFile({ id: "ttrpg" });
    expect(sel.enabled).toEqual([TTRPG_PROFILE]);
    expect(sel.customPacks).toEqual([]);
    expect(sel.customCategories).toEqual([]);
    expect(sel.issues).toEqual([]);
  });

  it("treats `version: 1` the same as no version", () => {
    const sel = parseProfileFile({ version: 1, id: "ttrpg" });
    expect(sel.enabled).toEqual([TTRPG_PROFILE]);
    expect(sel.customPacks).toEqual([]);
  });

  it("keeps a customised file as a custom pack, patched over its builtin", () => {
    const sel = parseProfileFile({ id: "ttrpg", sections: { outline: "推进方向" } });
    expect(sel.enabled[0].sections.outline).toBe("推进方向");
    expect(sel.enabled[0].sections.priorAll).toBe(TTRPG_PROFILE.sections.priorAll);
    expect(sel.customPacks).toEqual([sel.enabled[0]]);
  });

  it("falls back to novel for what an unrecognised id leaves out", () => {
    const sel = parseProfileFile({
      id: "nosuchprofile",
      categories: [{ id: "projects", labelZh: "项目", labelEn: "Projects" }],
    });
    expect(sel.enabled[0].id).toBe("nosuchprofile");
    expect(sel.enabled[0].categories.map((c) => c.id)).toEqual(["projects"]);
    // Tasks were omitted, so the novel fallback's are inherited.
    expect(sel.enabled[0].tasks).toEqual(NOVEL_PROFILE.tasks);
    expect(sel.customPacks).toEqual([sel.enabled[0]]);
  });

  it("notes and ignores the retired pack fields", () => {
    const sel = parseProfileFile({
      id: "ttrpg",
      systemPromptKey: "ai.instructions.custom",
      terms: { doc: { zh: "场景", en: "scene" } },
      docModel: { ordered: false },
    });
    // Still resolves to a usable pack; the retired fields are simply gone.
    expect(sel.enabled[0].id).toBe("ttrpg");
    expect(sel.issues.some((i) => i.includes("systemPromptKey"))).toBe(true);
    expect(sel.issues.some((i) => i.includes("terms"))).toBe(true);
    expect(sel.issues.some((i) => i.includes("docModel"))).toBe(true);
  });

  it("degrades non-object data to the novel selection with issues", () => {
    for (const data of [null, 42, "novel", ["novel"]]) {
      const sel = parseProfileFile(data);
      expect(sel.enabled).toEqual([NOVEL_PROFILE]);
      expect(sel.customPacks).toEqual([]);
      expect(sel.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("v2 files", () => {
  it("resolves builtins by bare id, primary first", () => {
    const sel = parseProfileFile({ version: 2, primary: "novel", enabled: ["novel", "bid"] });
    expect(sel.enabled).toEqual([NOVEL_PROFILE, BID_PROFILE]);
    expect(sel.customPacks).toEqual([]);
    expect(sel.issues).toEqual([]);
  });

  it("moves the primary to the front of a differently-ordered enabled list", () => {
    const sel = parseProfileFile({ version: 2, primary: "bid", enabled: ["novel", "bid"] });
    expect(sel.enabled.map((p) => p.id)).toEqual(["bid", "novel"]);
  });

  it("promotes a primary missing from the enabled list into it", () => {
    // `{"version":2,"primary":"ttrpg"}` should mean what it obviously meant.
    const sel = parseProfileFile({ version: 2, primary: "ttrpg" });
    expect(sel.enabled).toEqual([TTRPG_PROFILE]);
  });

  it("drops unknown enabled ids loudly, keeping the rest", () => {
    const sel = parseProfileFile({
      version: 2, primary: "novel", enabled: ["novel", "gonepack", "bid"],
    });
    expect(sel.enabled.map((p) => p.id)).toEqual(["novel", "bid"]);
    expect(sel.issues.some((i) => i.includes("gonepack"))).toBe(true);
  });

  it("keeps the enabled packs when the primary is unknown", () => {
    const sel = parseProfileFile({ version: 2, primary: "gonepack", enabled: ["bid"] });
    expect(sel.enabled).toEqual([BID_PROFILE]);
    expect(sel.issues.some((i) => i.includes("gonepack"))).toBe(true);
  });

  it("falls back to novel when nothing is usable — a v2 file always meant a pack", () => {
    const sel = parseProfileFile({ version: 2, primary: "nope", enabled: ["alsonope"] });
    expect(sel.enabled).toEqual([NOVEL_PROFILE]);
    expect(sel.issues.length).toBeGreaterThan(0);
  });

  it("resolves enabled ids through the file's own packs before the builtins", () => {
    const sel = parseProfileFile({
      version: 2,
      primary: "homebrew",
      enabled: ["homebrew", "novel"],
      packs: [{ id: "homebrew", categories: [{ id: "rules", labelZh: "规则", labelEn: "Rules" }] }],
    });
    expect(sel.enabled[0].id).toBe("homebrew");
    expect(sel.enabled[0].categories.map((c) => c.id)).toEqual(["rules"]);
    expect(sel.customPacks.map((p) => p.id)).toEqual(["homebrew"]);
  });

  it("lets a pack override the builtin of the same id — file beats built-in", () => {
    const sel = parseProfileFile({
      version: 2,
      primary: "ttrpg",
      enabled: ["ttrpg"],
      packs: [{ id: "ttrpg", sections: { outline: "冒险方向" } }],
    });
    expect(sel.enabled[0].sections.outline).toBe("冒险方向");
    // Patched over the builtin, not over novel.
    expect(sel.enabled[0].sections.prevTail).toBe(TTRPG_PROFILE.sections.prevTail);
  });

  it("keeps a custom pack that is not currently enabled", () => {
    // Disabling a pack must not delete its definition.
    const sel = parseProfileFile({
      version: 2,
      primary: "novel",
      enabled: ["novel"],
      packs: [{ id: "homebrew", categories: [{ id: "rules", labelZh: "规则", labelEn: "Rules" }] }],
    });
    expect(sel.enabled.map((p) => p.id)).toEqual(["novel"]);
    expect(sel.customPacks.map((p) => p.id)).toEqual(["homebrew"]);
  });

  it("tolerates malformed enabled/packs fields", () => {
    const sel = parseProfileFile({
      version: 2, primary: "novel", enabled: "novel", packs: { id: "x" },
    });
    expect(sel.enabled).toEqual([NOVEL_PROFILE]);
    expect(sel.issues.length).toBeGreaterThan(0);
  });
});

describe("v3 files", () => {
  it("resolves equal packs in file order, no primary anywhere", () => {
    const sel = parseProfileFile({ version: 3, enabled: ["bid", "novel"] });
    expect(sel.enabled).toEqual([BID_PROFILE, NOVEL_PROFILE]);
    expect(sel.customCategories).toEqual([]);
    expect(sel.issues).toEqual([]);
  });

  it("accepts an empty selection — a packs-free knowledge-base project", () => {
    const sel = parseProfileFile({ version: 3, enabled: [] });
    expect(sel.enabled).toEqual([]);
    expect(sel.issues).toEqual([]);
  });

  it("carries the project's user-defined categories", () => {
    const sel = parseProfileFile({
      version: 3,
      enabled: ["novel"],
      categories: [{ id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" }],
    });
    expect(sel.customCategories).toEqual([
      { id: "meetings", labelZh: "会议纪要", labelEn: "Meetings" },
    ]);
  });

  it("drops unusable user categories loudly, keeping the rest", () => {
    const sel = parseProfileFile({
      version: 3,
      enabled: [],
      categories: [
        { id: "../escape", labelZh: "坏", labelEn: "bad" },
        { id: "ok", labelZh: "好", labelEn: "ok" },
        { id: "OK", labelZh: "重复", labelEn: "dup" },
      ],
    });
    expect(sel.customCategories.map((c) => c.id)).toEqual(["ok"]);
    expect(sel.issues.length).toBeGreaterThan(0);
  });

  it("still resolves custom packs the way v2 did", () => {
    const sel = parseProfileFile({
      version: 3,
      enabled: ["homebrew"],
      packs: [{ id: "homebrew", categories: [{ id: "rules", labelZh: "规则", labelEn: "Rules" }] }],
    });
    expect(sel.enabled[0].id).toBe("homebrew");
    expect(sel.customPacks.map((p) => p.id)).toEqual(["homebrew"]);
  });
});
