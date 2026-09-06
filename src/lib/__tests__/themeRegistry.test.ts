import { describe, expect, it } from "vitest";
import {
  buildRegistry, displayThemeName, installableEntries, resolveMarkdownTheme, resolveUiTheme, usableCount,
  type ScannedThemeFile,
} from "../theme/registry";
import type { ThemeProblem } from "../theme/manifest";

const DIRS = { user: "/data/themes", project: "/proj/.ai-writer/themes" };
const both = { light: "paper", dark: "night", markdown: "manuscript" };

function ui(fileName: string, meta: Record<string, string>, tokens: Record<string, string> = {}, problems: ThemeProblem[] = [], dir = DIRS.user): ScannedThemeFile {
  return { fileName, path: `${dir}/${fileName}`, validation: { kind: "ui", meta, tokens, problems, kept: Object.keys(tokens).length } };
}
function md(fileName: string, meta: Record<string, string>, css = ".md-body { --md-line: 1.9; }", dir = DIRS.user, extra: Partial<{ ownFonts: boolean; ownColors: boolean; assets: string[] }> = {}): ScannedThemeFile {
  return {
    fileName, path: `${dir}/${fileName}`,
    validation: { kind: "markdown", meta: { "--theme-kind": "markdown", ...meta }, css, assets: [], problems: [], kept: 1, ownFonts: false, ownColors: false, ...extra },
  };
}

const xuanzhi = ui("宣纸.css", { "--theme-name": "宣纸", "--theme-scheme": "light" }, { "--color-bg-base": "#F3EEE3" });
const mo = ui("墨.css", { "--theme-name": "墨", "--theme-scheme": "dark" }, { "--color-sienna": "#D9925B" });
const songkai = md("宋楷.css", { "--theme-name": "宋楷", "--theme-extends": "manuscript" }, ".md-body { --md-font-body: Kaiti; }", DIRS.user, { ownFonts: true });

describe("buildRegistry — appearance", () => {
  it("lists built-ins first, then the folder's files by name", () => {
    const { ui: entries } = buildRegistry([mo, xuanzhi], [], both, DIRS);
    expect(entries.map((e) => e.id)).toEqual(["paper", "night", "墨", "宣纸"]);
    expect(entries[2]).toMatchObject({ source: "user", scheme: "dark", extends: "night", usable: true, path: `${DIRS.user}/墨.css` });
  });

  it("keeps an unreadable file as an unusable card named by its file", () => {
    const bad = ui("半调.css", { "--theme-scheme": "light" });
    const { ui: entries } = buildRegistry([bad], [], both, DIRS);
    const e = entries.find((x) => x.id === "半调");
    expect(e).toMatchObject({ usable: false, name: "半调.css" });
    expect(e?.missing).toBeUndefined();
    expect(e?.problems[0]).toEqual({ rule: 1, selector: ":root", reason: "missingMeta", params: { fields: "--theme-name" } });
  });

  it("keeps a file that could not be read at all", () => {
    const { ui: entries } = buildRegistry([{ fileName: "x.css", path: `${DIRS.user}/x.css`, error: "EACCES" }], [], both, DIRS);
    expect(entries.find((e) => e.id === "x")).toMatchObject({ usable: false, problems: [{ rule: 0, reason: "unreadableFile", params: { error: "EACCES" } }] });
  });

  it("refuses a file named like a built-in", () => {
    const { ui: entries } = buildRegistry([ui("paper.css", { "--theme-name": "假纸", "--theme-scheme": "light" })], [], both, DIRS);
    const papers = entries.filter((e) => e.id === "paper");
    expect(papers).toHaveLength(2);
    expect(papers[1].usable).toBe(false);
    expect(papers[1].problems[0]).toMatchObject({ reason: "reservedUiId", params: { id: "paper" } });
  });

  it("stands a missing card where a selected file would be, preference untouched", () => {
    const { ui: entries } = buildRegistry([], [], { ...both, light: "宣纸" }, DIRS);
    const m = entries.find((e) => e.id === "宣纸");
    expect(m).toMatchObject({ missing: true, usable: false, scheme: "light", fileName: "宣纸.css", path: `${DIRS.user}/宣纸.css` });
  });

  it("carries the dropped rules and the kept count onto the card", () => {
    const f = ui("冷灰.css", { "--theme-name": "冷灰", "--theme-scheme": "light" }, { "--color-sienna": "#555" }, [
      { rule: 2, selector: "body", reason: "uiSelector" },
    ]);
    const { ui: entries } = buildRegistry([f], [], both, DIRS);
    expect(entries.find((e) => e.id === "冷灰")).toMatchObject({ usable: true, kept: 1, problems: [{ rule: 2 }] });
  });

  it("never lets a ui theme in from the project folder", () => {
    const { ui: entries, markdown } = buildRegistry([], [ui("evil.css", { "--theme-name": "x", "--theme-scheme": "dark" }, {}, [], DIRS.project)], both, DIRS);
    expect(entries.map((e) => e.id)).toEqual(["paper", "night"]);
    const shown = markdown.find((e) => e.id === "evil");
    expect(shown).toMatchObject({ source: "project", usable: false });
    expect(shown?.problems[0].reason).toBe("uiInProject");
  });
});

describe("buildRegistry — typography", () => {
  it("lists the five built-ins, then the author's, then the project's", () => {
    const brand = md("brand.css", { "--theme-name": "品牌白皮书" }, ".md-body { color: #222; }", DIRS.project, { ownColors: true });
    const { markdown } = buildRegistry([songkai], [brand], both, DIRS);
    expect(markdown.map((e) => e.id)).toEqual(["manuscript", "clean", "magazine", "wechat", "typewriter", "宋楷", "brand"]);
    expect(markdown[5]).toMatchObject({ source: "user", extends: "manuscript", ownFonts: true, css: ".md-body { --md-font-body: Kaiti; }" });
    expect(markdown[6]).toMatchObject({ source: "project", ownColors: true, path: `${DIRS.project}/brand.css` });
  });

  it("lets a project file replace the author's file of the same id, whole", () => {
    const projectSongkai = md("宋楷.css", { "--theme-name": "项目宋楷" }, ".md-body { --md-line: 2; }", DIRS.project);
    const { markdown } = buildRegistry([songkai], [projectSongkai], both, DIRS);
    const hits = markdown.filter((e) => e.id === "宋楷");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: "project", name: "项目宋楷" });
  });

  it("refuses a file named like a built-in and keeps its card", () => {
    const { markdown } = buildRegistry([md("clean.css", { "--theme-name": "x" })], [], both, DIRS);
    expect(markdown.filter((e) => e.id === "clean")).toHaveLength(2);
    expect(markdown.filter((e) => e.id === "clean")[1].usable).toBe(false);
  });

  it("stands a missing card for a selected id no folder has", () => {
    const { markdown } = buildRegistry([], [], { ...both, markdown: "宋楷" }, DIRS);
    expect(markdown.find((e) => e.id === "宋楷")).toMatchObject({ kind: "markdown", missing: true, usable: false, extends: "manuscript" });
  });

  it("notes a bad --theme-extends and falls to manuscript", () => {
    const { markdown } = buildRegistry([md("x.css", { "--theme-name": "x", "--theme-extends": "paper" })], [], both, DIRS);
    const e = markdown.find((x) => x.id === "x");
    expect(e).toMatchObject({ usable: true, extends: "manuscript" });
    expect(e?.problems[0]).toMatchObject({ selector: "--theme-extends", reason: "badExtendsMd", params: { base: "manuscript" } });
  });
});

describe("resolve", () => {
  it("returns the selected ui entry when it is usable and of that polarity, else the built-in", () => {
    const { ui: entries } = buildRegistry([mo, xuanzhi, ui("半调.css", {})], [], { ...both, light: "宣纸", dark: "墨" }, DIRS);
    expect(resolveUiTheme(entries, "light", "宣纸").id).toBe("宣纸");
    expect(resolveUiTheme(entries, "light", "半调").id).toBe("paper");
    expect(resolveUiTheme(entries, "light", "墨").id).toBe("paper");
    expect(resolveUiTheme(entries, "dark", "墨").id).toBe("墨");
    expect(resolveUiTheme(entries, "dark", "nope").id).toBe("night");
  });

  it("returns the selected typography entry when usable, else manuscript", () => {
    const { markdown } = buildRegistry([songkai], [], { ...both, markdown: "gone" }, DIRS);
    expect(resolveMarkdownTheme(markdown, "宋楷").id).toBe("宋楷");
    expect(resolveMarkdownTheme(markdown, "clean").id).toBe("clean");
    expect(resolveMarkdownTheme(markdown, "gone").id).toBe("manuscript");
  });
});

describe("helpers", () => {
  it("installs every usable user ui theme, never a built-in", () => {
    const { ui: entries } = buildRegistry([mo, xuanzhi, ui("半调.css", {})], [], both, DIRS);
    expect(installableEntries(entries).map((e) => e.id)).toEqual(["墨", "宣纸"]);
  });

  it("counts usable cards, built-ins included", () => {
    const { ui: entries, markdown } = buildRegistry([mo, ui("半调.css", {})], [], { ...both, light: "gone" }, DIRS);
    expect(usableCount(entries)).toBe(3);
    expect(usableCount(markdown)).toBe(5);
  });

  it("names built-ins bilingually and user themes as written", () => {
    const { ui: entries, markdown } = buildRegistry([xuanzhi], [], both, DIRS);
    expect(displayThemeName(entries[0], true)).toBe("纸");
    expect(displayThemeName(entries[0], false)).toBe("Paper");
    expect(displayThemeName(entries[2], false)).toBe("宣纸");
    expect(displayThemeName(markdown[0], true)).toBe("手稿");
  });
});
