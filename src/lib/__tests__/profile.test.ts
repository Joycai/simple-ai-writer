/**
 * Workspace-profile tests: defensive parsing of `profile.json` (its category ids
 * become directory names, so this is the layer that must not pass junk through),
 * and the active-profile accessors the lore/agent/prompt code reads.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  BID_PROFILE,
  BUILTIN_PROFILES,
  CATEGORY_ID_RE,
  COPY_PROFILE,
  DEFAULT_DOC_MODEL,
  DEFAULT_SECTION_LABELS,
  DEFAULT_TERMS,
  NOVEL_PROFILE,
  TTRPG_PROFILE,
  builtinProfile,
  parseProfile,
  profileTerms,
  type WorkspaceProfile,
} from "../profile/model";
import {
  activeProfile,
  defaultCategoryId,
  fallbackCategoryId,
  findCategory,
  isKnownCategory,
  loreCategories,
  loreCategoryIds,
  resetActiveProfile,
  sectionLabel,
  setActiveProfile,
} from "../profile/active";

// The active profile is a module singleton, so a test that switches it must put
// it back or it leaks into every test that runs afterwards.
afterEach(() => resetActiveProfile());

describe("builtin profiles", () => {
  it("defaults to novel and exposes the ttrpg profile", () => {
    expect(activeProfile()).toBe(NOVEL_PROFILE);
    expect(builtinProfile("ttrpg")).toBe(TTRPG_PROFILE);
    expect(builtinProfile("bid")?.labelZh).toBe("标书应答");
    expect(builtinProfile("nope")).toBeNull();
  });

  it("gives every builtin a unique id and non-empty categories", () => {
    const ids = BUILTIN_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of BUILTIN_PROFILES) {
      expect(p.categories.length).toBeGreaterThan(0);
      // Category ids are folder names. Asserted against the exported rule
      // itself (which `valid_category` in Rust mirrors) rather than a copy of
      // it here, so the check cannot drift from what parseProfile enforces.
      for (const c of p.categories) expect(c.id).toMatch(CATEGORY_ID_RE);
      expect(new Set(p.categories.map((c) => c.id)).size).toBe(p.categories.length);
    }
  });

  it("keeps novel wording as the section defaults", () => {
    // NOVEL_PROFILE overrides nothing, so the defaults must already read as the
    // novel labels — otherwise existing projects would silently change prompts.
    expect(NOVEL_PROFILE.sections).toEqual({});
    expect(sectionLabel("prevTail")).toBe("上一章结尾");
    expect(sectionLabel("knowledge")).toBe("设定资料");
  });
});

describe("active profile accessors", () => {
  it("follows setActiveProfile for categories and section labels", () => {
    setActiveProfile(TTRPG_PROFILE);

    expect(loreCategoryIds()).toContain("npcs");
    expect(loreCategoryIds()).not.toContain("characters");
    expect(isKnownCategory("rules")).toBe(true);
    expect(isKnownCategory("skills")).toBe(false);
    expect(findCategory("npcs")?.labelEn).toBe("NPCs");
    expect(findCategory("skills")).toBeNull();

    // Overridden section, and one that falls through to the default.
    expect(sectionLabel("prevTail")).toBe("上一场景结尾");
    expect(sectionLabel("recent")).toBe(DEFAULT_SECTION_LABELS.recent);
  });

  it("distinguishes the form default from the bad-input fallback", () => {
    setActiveProfile(TTRPG_PROFILE);
    expect(defaultCategoryId()).toBe("npcs"); // first category
    expect(fallbackCategoryId()).toBe("custom"); // misc bucket

    const noCustom: WorkspaceProfile = {
      ...TTRPG_PROFILE,
      categories: [{ id: "scenes", labelZh: "场景", labelEn: "Scenes" }],
    };
    setActiveProfile(noCustom);
    // With no "custom" bucket both must still name a category that exists.
    expect(fallbackCategoryId()).toBe("scenes");
    expect(defaultCategoryId()).toBe("scenes");
  });

  it("restores the novel profile on reset", () => {
    setActiveProfile(TTRPG_PROFILE);
    resetActiveProfile();
    expect(loreCategories()).toBe(NOVEL_PROFILE.categories);
  });
});

describe("parseProfile", () => {
  it("resolves a minimal file naming a builtin back to that builtin exactly", () => {
    // `{"id":"ttrpg"}` is the most natural hand-written profile. Every field it
    // omits must inherit — losing the section labels here would quietly prompt a
    // TTRPG author with 【上一章结尾】 — and it must produce no warnings.
    const { profile, issues } = parseProfile({ id: "ttrpg" }, TTRPG_PROFILE);
    expect(profile).toEqual(TTRPG_PROFILE);
    expect(issues).toEqual([]);
  });

  it("keeps its own labels when the file is not the fallback profile", () => {
    // Inheriting labels unconditionally would title a "weekly" project 小说.
    const { profile } = parseProfile(
      { id: "weekly", categories: [{ id: "projects", labelZh: "项目", labelEn: "Projects" }] },
      NOVEL_PROFILE,
    );
    expect(profile.labelZh).toBe("weekly");
    expect(profile.labelEn).toBe("weekly");
  });

  it("reads a full custom profile", () => {
    const { profile, issues } = parseProfile(
      {
        id: "weekly",
        labelZh: "周报",
        labelEn: "Weekly",
        categories: [
          { id: "projects", labelZh: "项目", labelEn: "Projects" },
          { id: "people", labelZh: "同事", labelEn: "People" },
        ],
        sections: { knowledge: "背景资料", prevTail: "上期周报" },
        systemPromptKey: "ai.instructions.system",
      },
      NOVEL_PROFILE,
    );
    expect(issues).toEqual([]);
    expect(profile.id).toBe("weekly");
    expect(profile.categories.map((c) => c.id)).toEqual(["projects", "people"]);
    expect(profile.sections.knowledge).toBe("背景资料");
  });

  it("drops category ids that are not a single safe folder name", () => {
    const { profile, issues } = parseProfile(
      {
        id: "x",
        categories: [
          { id: "good", labelZh: "好", labelEn: "Good" },
          { id: "../escape", labelZh: "坏", labelEn: "Bad" },
          { id: "a/b", labelZh: "坏", labelEn: "Bad" },
          { id: "", labelZh: "坏", labelEn: "Bad" },
          { id: "..", labelZh: "坏", labelEn: "Bad" },
          "not-an-object",
        ],
      },
      NOVEL_PROFILE,
    );
    expect(profile.categories.map((c) => c.id)).toEqual(["good"]);
    // Each rejection is reported, and named — asserting *which* entries were
    // complained about rather than how many diagnostics the parser happens to
    // emit, so adding a new message elsewhere doesn't break this test.
    const reported = issues.join(" | ");
    for (const bad of ["../escape", "a/b", ".."]) expect(reported).toContain(bad);
    expect(reported).toContain('category id "" is not a valid folder name');
    expect(reported).toContain("category entry is not an object");
  });

  it("rejects case-insensitive duplicate ids", () => {
    // Windows would map "Items" and "items" onto one directory.
    const { profile, issues } = parseProfile(
      {
        id: "x",
        categories: [
          { id: "items", labelZh: "道具", labelEn: "Items" },
          { id: "Items", labelZh: "重复", labelEn: "Dup" },
        ],
      },
      NOVEL_PROFILE,
    );
    expect(profile.categories.map((c) => c.id)).toEqual(["items"]);
    expect(issues.join(" ")).toContain("duplicate");
  });

  it("falls back wholesale when the file is not even an object", () => {
    for (const bad of [null, "string", 42, []]) {
      const { profile, issues } = parseProfile(bad, TTRPG_PROFILE);
      expect(profile).toBe(TTRPG_PROFILE);
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  it("inherits categories — with a warning — when a declared list yields none", () => {
    // The file is otherwise usable, so its own id/labels/sections survive; only
    // the layout falls back. Discarding the whole file would throw away work the
    // author *did* get right.
    for (const categories of [[], [{ id: ".." }], "nonsense"]) {
      const { profile, issues } = parseProfile({ id: "x", categories }, TTRPG_PROFILE);
      expect(profile.id).toBe("x");
      expect(profile.categories).toEqual(TTRPG_PROFILE.categories);
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the id when a label is unusable", () => {
    const { profile } = parseProfile(
      { id: "x", categories: [{ id: "npcs", labelZh: "   ", labelEn: 42 }] },
      NOVEL_PROFILE,
    );
    expect(profile.categories[0]).toEqual({ id: "npcs", labelZh: "npcs", labelEn: "npcs" });
  });

  it("ignores unknown sections and unusable labels", () => {
    const { profile, issues } = parseProfile(
      {
        id: "x",
        categories: [{ id: "a", labelZh: "A", labelEn: "A" }],
        sections: { knowledge: "资料", nonsense: "x", recent: "" , outline: "y".repeat(21) },
      },
      NOVEL_PROFILE,
    );
    expect(profile.sections).toEqual({ knowledge: "资料" });
    const reported = issues.join(" | ");
    expect(reported).toContain('unknown section "nonsense"');
    // Empty, and over the 20-char label cap.
    expect(reported).toContain('section "recent" has an unusable label');
    expect(reported).toContain('section "outline" has an unusable label');
  });

  it("refuses a systemPromptKey that is not an i18n key", () => {
    const { profile, issues } = parseProfile(
      {
        id: "x",
        categories: [{ id: "a", labelZh: "A", labelEn: "A" }],
        systemPromptKey: "../../etc/passwd",
      },
      NOVEL_PROFILE,
    );
    expect(profile.systemPromptKey).toBe(NOVEL_PROFILE.systemPromptKey);
    expect(issues.join(" ")).toContain("systemPromptKey");
  });

  it("layers docModel over the fallback's", () => {
    // Turning one flag off must not silently re-enable the other two.
    const { profile, issues } = parseProfile(
      { id: "copy", docModel: { memory: false } },
      COPY_PROFILE,
    );
    expect(profile.docModel).toEqual({ ordered: false, priorContext: false, memory: false });
    expect(issues).toEqual([]);

    const partial = parseProfile({ id: "novel", docModel: { memory: false } }, NOVEL_PROFILE);
    expect(partial.profile.docModel).toEqual({ ordered: true, priorContext: true, memory: false });
  });

  it("defaults docModel to novel behaviour and rejects non-booleans", () => {
    const { profile: inherited } = parseProfile(
      { id: "x", categories: [{ id: "a", labelZh: "A", labelEn: "A" }] },
      NOVEL_PROFILE,
    );
    expect(inherited.docModel).toEqual(DEFAULT_DOC_MODEL);

    // A hand-edited JSON file is exactly where `"false"` shows up, and a truthy
    // string flipping a feature on is worse than being told it's invalid.
    const { profile, issues } = parseProfile(
      {
        id: "x",
        categories: [{ id: "a", labelZh: "A", labelEn: "A" }],
        docModel: { memory: "false", nonsense: true },
      },
      NOVEL_PROFILE,
    );
    expect(profile.docModel).toEqual(DEFAULT_DOC_MODEL);
    expect(issues.join(" ")).toContain("docModel.memory");
    expect(issues.join(" ")).toContain("nonsense");
  });

  it("refuses priorContext without ordered", () => {
    // "The previous document" is meaningless with no order to read it from.
    const { profile, issues } = parseProfile(
      {
        id: "x",
        categories: [{ id: "a", labelZh: "A", labelEn: "A" }],
        docModel: { ordered: false, priorContext: true },
      },
      NOVEL_PROFILE,
    );
    expect(profile.docModel.priorContext).toBe(false);
    expect(issues.join(" ")).toContain("priorContext");
  });

  it("keeps every builtin's docModel self-consistent", () => {
    for (const p of BUILTIN_PROFILES) {
      if (p.docModel.priorContext) expect(p.docModel.ordered).toBe(true);
    }
  });

  it("layers terms over the fallback's and validates their shape", () => {
    // Overriding one term keeps the fallback profile's wording for the rest —
    // wholesale replacement would fall through to the novel words.
    const { profile, issues } = parseProfile(
      { id: "bid", terms: { doc: { zh: "条款", en: "clause" } } },
      BID_PROFILE,
    );
    expect(issues).toEqual([]);
    expect(profile.terms.doc).toEqual({ zh: "条款", en: "clause" });
    expect(profile.terms.kb).toEqual(BID_PROFILE.terms.kb);

    const bad = parseProfile(
      {
        id: "x",
        categories: [{ id: "a", labelZh: "A", labelEn: "A" }],
        terms: {
          nonsense: { zh: "x", en: "x" },
          doc: "not-an-object",
          group: { zh: "组" },
          entry: { zh: "条", en: "item", enPlural: 42 },
        },
      },
      NOVEL_PROFILE,
    );
    const reported = bad.issues.join(" | ");
    expect(reported).toContain('unknown term "nonsense"');
    expect(reported).toContain('term "doc" is not an object');
    expect(reported).toContain('term "group" needs both zh and en labels');
    expect(reported).toContain('term "entry" has an unusable enPlural');
    // The half-valid entries fall back rather than half-apply.
    expect(bad.profile.terms.doc).toBeUndefined();
    expect(bad.profile.terms.group).toBeUndefined();
    // entry itself was usable — only its enPlural was dropped.
    expect(bad.profile.terms.entry).toEqual({ zh: "条", en: "item" });
  });

  it("resolves terms per language with plural fallbacks", () => {
    // Novel overrides nothing, so the defaults must already be the novel words.
    expect(NOVEL_PROFILE.terms).toEqual({});
    const zh = profileTerms(NOVEL_PROFILE, true);
    expect(zh.doc).toBe(DEFAULT_TERMS.doc.zh);
    expect(zh.docs).toBe(zh.doc); // Chinese has no plural form
    expect(zh.entries).toBe("设定");

    const en = profileTerms(NOVEL_PROFILE, false);
    expect(en.docs).toBe("chapters"); // default en + "s"
    expect(en.entries).toBe("lore entries"); // explicit enPlural wins

    const bid = profileTerms(BID_PROFILE, true);
    expect(bid.kb).toBe("企业知识库");
    expect(bid.doc).toBe("文档");
  });

  it("caps the category count", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      labelZh: `c${i}`,
      labelEn: `c${i}`,
    }));
    const { profile, issues } = parseProfile({ id: "x", categories: many }, NOVEL_PROFILE);
    expect(profile.categories.length).toBe(24);
    expect(issues.join(" ")).toContain("24");
  });
});
