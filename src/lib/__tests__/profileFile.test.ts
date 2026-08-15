/**
 * profile.json's two generations (lib/profile/file).
 *
 * The v1 branch is the compatibility surface: every project created before
 * packs existed reads through it, so it must reproduce the old loader's
 * behaviour exactly — including which files count as customised. The v2
 * branch is arbitration over hand-editable data, so like parseProfile it
 * drops what it can't use, loudly, and never throws.
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
    expect(sel.primary).toEqual(TTRPG_PROFILE);
    expect(sel.enabled).toEqual([TTRPG_PROFILE]);
    expect(sel.customPacks).toEqual([]);
    expect(sel.issues).toEqual([]);
  });

  it("treats `version: 1` the same as no version", () => {
    const sel = parseProfileFile({ version: 1, id: "ttrpg" });
    expect(sel.primary).toEqual(TTRPG_PROFILE);
    expect(sel.customPacks).toEqual([]);
  });

  it("keeps a customised file as a custom pack, patched over its builtin", () => {
    const sel = parseProfileFile({ id: "ttrpg", sections: { outline: "推进方向" } });
    expect(sel.primary.sections.outline).toBe("推进方向");
    expect(sel.primary.sections.knowledge).toBe(TTRPG_PROFILE.sections.knowledge);
    expect(sel.customPacks).toEqual([sel.primary]);
  });

  it("falls back to novel for what an unrecognised id leaves out", () => {
    const sel = parseProfileFile({
      id: "nosuchprofile",
      categories: [{ id: "projects", labelZh: "项目", labelEn: "Projects" }],
    });
    expect(sel.primary.id).toBe("nosuchprofile");
    expect(sel.primary.categories.map((c) => c.id)).toEqual(["projects"]);
    expect(sel.primary.systemPromptKey).toBe(NOVEL_PROFILE.systemPromptKey);
    expect(sel.customPacks).toEqual([sel.primary]);
  });

  it("degrades non-object data to the novel selection with issues", () => {
    for (const data of [null, 42, "novel", ["novel"]]) {
      const sel = parseProfileFile(data);
      expect(sel.primary).toEqual(NOVEL_PROFILE);
      expect(sel.enabled).toEqual([NOVEL_PROFILE]);
      expect(sel.customPacks).toEqual([]);
      expect(sel.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("v2 files", () => {
  it("resolves builtins by bare id, primary first", () => {
    const sel = parseProfileFile({ version: 2, primary: "novel", enabled: ["novel", "bid"] });
    expect(sel.primary).toEqual(NOVEL_PROFILE);
    expect(sel.enabled).toEqual([NOVEL_PROFILE, BID_PROFILE]);
    expect(sel.customPacks).toEqual([]);
    expect(sel.issues).toEqual([]);
  });

  it("moves the primary to the front of a differently-ordered enabled list", () => {
    const sel = parseProfileFile({ version: 2, primary: "bid", enabled: ["novel", "bid"] });
    expect(sel.enabled.map((p) => p.id)).toEqual(["bid", "novel"]);
  });

  it("promotes a primary missing from the enabled list into it", () => {
    // `{"version":2,"primary":"ttrpg"}` should mean what it obviously means.
    const sel = parseProfileFile({ version: 2, primary: "ttrpg" });
    expect(sel.primary).toEqual(TTRPG_PROFILE);
    expect(sel.enabled).toEqual([TTRPG_PROFILE]);
  });

  it("drops unknown enabled ids loudly, keeping the rest", () => {
    const sel = parseProfileFile({
      version: 2, primary: "novel", enabled: ["novel", "gonepack", "bid"],
    });
    expect(sel.enabled.map((p) => p.id)).toEqual(["novel", "bid"]);
    expect(sel.issues.some((i) => i.includes("gonepack"))).toBe(true);
  });

  it("falls back to an enabled pack when the primary is unknown", () => {
    const sel = parseProfileFile({ version: 2, primary: "gonepack", enabled: ["bid"] });
    expect(sel.primary).toEqual(BID_PROFILE);
    expect(sel.issues.some((i) => i.includes("gonepack"))).toBe(true);
  });

  it("falls back to novel when nothing is usable", () => {
    const sel = parseProfileFile({ version: 2, primary: "nope", enabled: ["alsonope"] });
    expect(sel.primary).toEqual(NOVEL_PROFILE);
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
    expect(sel.primary.id).toBe("homebrew");
    expect(sel.primary.categories.map((c) => c.id)).toEqual(["rules"]);
    expect(sel.customPacks.map((p) => p.id)).toEqual(["homebrew"]);
  });

  it("lets a pack override the builtin of the same id — file beats built-in", () => {
    const sel = parseProfileFile({
      version: 2,
      primary: "ttrpg",
      enabled: ["ttrpg"],
      packs: [{ id: "ttrpg", sections: { outline: "冒险方向" } }],
    });
    expect(sel.primary.sections.outline).toBe("冒险方向");
    // Patched over the builtin, not over novel.
    expect(sel.primary.sections.knowledge).toBe(TTRPG_PROFILE.sections.knowledge);
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
    expect(sel.primary).toEqual(NOVEL_PROFILE);
    expect(sel.issues.length).toBeGreaterThan(0);
  });
});
