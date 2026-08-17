/**
 * Capability-pack tests: defensive parsing of `profile.json` (its category ids
 * become directory names, so this is the layer that must not pass junk
 * through), and the active-workspace accessors the lore/agent/prompt code
 * reads.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  appTerms,
  BID_PROFILE,
  BUILTIN_PROFILES,
  CATEGORY_ID_RE,
  DEFAULT_SECTION_LABELS,
  DEFAULT_TERMS,
  NOVEL_PROFILE,
  TTRPG_PROFILE,
  builtinProfile,
  parseProfile,
  suggestCategoryId,
} from "../profile/model";
import {
  activeWorkspace,
  defaultCategoryId,
  fallbackCategoryId,
  findCategory,
  isKnownCategory,
  loreCategories,
  loreCategoryIds,
  promptParams,
  resetActiveWorkspace,
  sectionLabel,
  setActiveWorkspace,
} from "../profile/active";
import { CUSTOM_CATEGORY, resolveWorkspace } from "../profile/resolve";

// The active workspace is a module singleton, so a test that switches it must
// put it back or it leaks into every test that runs afterwards.
afterEach(() => resetActiveWorkspace());

describe("builtin packs", () => {
  it("defaults to novel and exposes the ttrpg pack", () => {
    expect(activeWorkspace().enabled).toEqual([NOVEL_PROFILE]);
    expect(builtinProfile("ttrpg")).toBe(TTRPG_PROFILE);
    expect(builtinProfile("bid")?.labelZh).toBe("标书应答");
    expect(builtinProfile("wechat")?.labelZh).toBe("微信公众号");
    expect(builtinProfile("nope")).toBeNull();
  });

  it("gives every builtin a unique id and valid category ids", () => {
    const ids = BUILTIN_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of BUILTIN_PROFILES) {
      expect(p.categories.length).toBeGreaterThan(0);
      // Category ids are folder names. Asserted against the exported rule
      // itself (which `valid_category` in Rust mirrors) rather than a copy of
      // it here, so the check cannot drift from what parseProfile enforces.
      for (const c of p.categories) expect(c.id).toMatch(CATEGORY_ID_RE);
      expect(new Set(p.categories.map((c) => c.id)).size).toBe(p.categories.length);
      // The custom bucket is app-level; no pack may declare it.
      expect(p.categories.some((c) => c.id === CUSTOM_CATEGORY.id)).toBe(false);
    }
  });

  it("keeps the section defaults neutral, with novel overriding its own wording", () => {
    // The defaults serve every project, so they must be domain-neutral; the
    // novel pack carries the fiction wording as ordinary overrides.
    expect(sectionLabel("prevTail")).toBe("上一篇结尾");
    expect(sectionLabel("knowledge")).toBe("知识库");
    expect(sectionLabel("prevTail", "novel")).toBe("上一章结尾");
    // No built-in renames the knowledge base — 知识库 is uniform.
    for (const p of BUILTIN_PROFILES) expect(p.sections.knowledge).toBeUndefined();
  });
});

describe("active workspace accessors", () => {
  it("follows setActiveWorkspace for categories and section labels", () => {
    setActiveWorkspace(resolveWorkspace([TTRPG_PROFILE]));

    expect(loreCategoryIds()).toContain("npcs");
    expect(loreCategoryIds()).not.toContain("characters");
    expect(isKnownCategory("rules")).toBe(true);
    expect(isKnownCategory("skills")).toBe(false);
    expect(findCategory("npcs")?.labelEn).toBe("NPCs");
    expect(findCategory("skills")).toBeNull();

    // Pack-scoped override, and the neutral default without a packId.
    expect(sectionLabel("prevTail", "ttrpg")).toBe("上一场景结尾");
    expect(sectionLabel("recent")).toBe(DEFAULT_SECTION_LABELS.recent);
  });

  it("distinguishes the form default from the bad-input fallback", () => {
    setActiveWorkspace(resolveWorkspace([TTRPG_PROFILE]));
    expect(defaultCategoryId()).toBe("npcs"); // first category
    expect(fallbackCategoryId()).toBe("custom"); // misc bucket

    // The custom bucket is app-level, so it exists whatever is enabled —
    // including nothing at all.
    setActiveWorkspace(resolveWorkspace([]));
    expect(fallbackCategoryId()).toBe("custom");
    expect(defaultCategoryId()).toBe("custom");
  });

  it("builds prompt interpolation params from the app vocabulary + task pack", () => {
    setActiveWorkspace(resolveWorkspace([BID_PROFILE]));
    // Terms are app-level and uniform — the knowledge base is 知识库
    // everywhere, whatever packs are enabled.
    const params = promptParams(true);
    expect(params.kb).toBe("知识库");
    expect(params.doc).toBe("文档");
    expect(params.knowledge).toBe("知识库");
    expect(params.outlineSection).toBe(DEFAULT_SECTION_LABELS.outline);

    // A bid task's assembly passes its packId and gets bid wording for the
    // sections bid overrides.
    const bidParams = promptParams(true, "bid");
    expect(bidParams.outlineSection).toBe("应答大纲");
    expect(bidParams.recent).toBe("当前应答");
    expect(bidParams.knowledge).toBe("知识库"); // never renamed

    const en = promptParams(false);
    expect(en.kb).toBe("Knowledge Base");
  });

  it("restores the novel pack on reset", () => {
    setActiveWorkspace(resolveWorkspace([TTRPG_PROFILE]));
    resetActiveWorkspace();
    expect(activeWorkspace().enabled).toEqual([NOVEL_PROFILE]);
    // The merged view wraps the categories (adding packIds) and appends the
    // app-level custom bucket.
    expect(loreCategories().map(({ packIds, userDefined, ...cat }) => cat)).toEqual([
      ...NOVEL_PROFILE.categories,
      CUSTOM_CATEGORY,
    ]);
  });
});

describe("app vocabulary", () => {
  it("resolves per language with plural fallbacks", () => {
    const zh = appTerms(true);
    expect(zh.kb).toBe("知识库");
    expect(zh.doc).toBe(DEFAULT_TERMS.doc.zh);
    expect(zh.docs).toBe(zh.doc); // Chinese has no plural form

    const en = appTerms(false);
    expect(en.kb).toBe("Knowledge Base");
    expect(en.docs).toBe("documents"); // default en + "s"
    expect(en.entries).toBe("entries"); // explicit enPlural wins
  });
});

describe("suggestCategoryId", () => {
  it("slugs a latin label and falls back to a neutral stem for CJK", () => {
    expect(suggestCategoryId("Meeting Notes", [])).toBe("meeting-notes");
    expect(suggestCategoryId("会议纪要", [])).toBe("kb");
  });

  it("numbers past taken ids, case-insensitively", () => {
    expect(suggestCategoryId("会议纪要", ["kb"])).toBe("kb-2");
    expect(suggestCategoryId("Notes", ["NOTES", "notes-2"])).toBe("notes-3");
  });

  it("always yields a valid folder name", () => {
    for (const label of ["会议纪要", "---", "A B C", "", "日程 2026"]) {
      expect(suggestCategoryId(label, [])).toMatch(CATEGORY_ID_RE);
    }
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

  it("reads a full custom pack", () => {
    const { profile, issues } = parseProfile(
      {
        id: "weekly",
        labelZh: "周报",
        labelEn: "Weekly",
        categories: [
          { id: "projects", labelZh: "项目", labelEn: "Projects" },
          { id: "people", labelZh: "同事", labelEn: "People" },
        ],
        sections: { outline: "本期要点", prevTail: "上期周报" },
      },
      NOVEL_PROFILE,
    );
    expect(issues).toEqual([]);
    expect(profile.id).toBe("weekly");
    expect(profile.categories.map((c) => c.id)).toEqual(["projects", "people"]);
    expect(profile.sections.outline).toBe("本期要点");
  });

  it("accepts a declared-empty category list — a tasks-only pack", () => {
    const { profile, issues } = parseProfile(
      { id: "x", categories: [], tasks: [{ id: "draft", tools: "none", target: "detached", freeform: true }] },
      NOVEL_PROFILE,
    );
    expect(profile.categories).toEqual([]);
    expect(issues).toEqual([]);
  });

  it("notes and ignores the retired pack fields", () => {
    const { profile, issues } = parseProfile(
      {
        id: "x",
        categories: [{ id: "a", labelZh: "A", labelEn: "A" }],
        terms: { doc: { zh: "条款", en: "clause" } },
        docModel: { ordered: false },
        systemPromptKey: "ai.instructions.custom",
      },
      NOVEL_PROFILE,
    );
    expect(profile.categories.map((c) => c.id)).toEqual(["a"]);
    expect((profile as unknown as Record<string, unknown>).terms).toBeUndefined();
    const reported = issues.join(" | ");
    for (const key of ["terms", "docModel", "systemPromptKey"]) {
      expect(reported).toContain(key);
    }
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
    // the layout falls back. A declared *empty* list is different (see above):
    // that is a deliberate tasks-only pack, not breakage.
    for (const categories of [[{ id: ".." }], "nonsense"]) {
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
    // Layered over the fallback's own overrides, as always.
    expect(profile.sections).toEqual({ ...NOVEL_PROFILE.sections, knowledge: "资料" });
    const reported = issues.join(" | ");
    expect(reported).toContain('unknown section "nonsense"');
    // Empty, and over the 20-char label cap.
    expect(reported).toContain('section "recent" has an unusable label');
    expect(reported).toContain('section "outline" has an unusable label');
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
