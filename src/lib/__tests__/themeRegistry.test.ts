import { describe, expect, it } from "vitest";
import {
  buildUiRegistry, displayThemeName, installableEntries, resolveUiTheme, usableCount, type ScannedThemeFile,
} from "../theme/registry";
import type { UiThemeValidation } from "../theme/validate";

const DIR = "/data/themes";
const both = { light: "paper", dark: "night" };

function file(fileName: string, meta: Record<string, string>, tokens: Record<string, string> = {}, problems: UiThemeValidation["problems"] = []): ScannedThemeFile {
  return { fileName, path: `${DIR}/${fileName}`, validation: { meta, tokens, problems, kept: Object.keys(tokens).length } };
}

const xuanzhi = file("宣纸.css", { "--theme-name": "宣纸", "--theme-scheme": "light" }, { "--color-bg-base": "#F3EEE3" });
const mo = file("墨.css", { "--theme-name": "墨", "--theme-scheme": "dark" }, { "--color-sienna": "#D9925B" });

describe("buildUiRegistry", () => {
  it("lists built-ins first, then the folder's files by name", () => {
    const { entries } = buildUiRegistry([mo, xuanzhi], both, DIR);
    expect(entries.map((e) => e.id)).toEqual(["paper", "night", "墨", "宣纸"]);
    expect(entries[2]).toMatchObject({ source: "user", scheme: "dark", extends: "night", usable: true, path: `${DIR}/墨.css` });
  });

  it("keeps an unreadable file as an unusable card named by its file", () => {
    const bad = file("半调.css", { "--theme-scheme": "light" });
    const { entries } = buildUiRegistry([bad], both, DIR);
    const e = entries.find((x) => x.id === "半调");
    expect(e).toMatchObject({ usable: false, name: "半调.css" });
    expect(e?.missing).toBeUndefined();
    expect(e?.problems[0].reason).toBe("缺 --theme-name");
  });

  it("keeps a file that could not be read at all", () => {
    const { entries } = buildUiRegistry([{ fileName: "x.css", path: `${DIR}/x.css`, error: "EACCES" }], both, DIR);
    expect(entries.find((e) => e.id === "x")).toMatchObject({ usable: false, problems: [{ rule: 0, reason: "读不出文件 · EACCES" }] });
  });

  it("refuses a file named like a built-in", () => {
    const { entries } = buildUiRegistry([file("paper.css", { "--theme-name": "假纸", "--theme-scheme": "light" })], both, DIR);
    const papers = entries.filter((e) => e.id === "paper");
    expect(papers).toHaveLength(2);
    expect(papers[1].usable).toBe(false);
    expect(papers[1].problems[0].reason).toContain("内置");
  });

  it("sets markdown files aside and counts them", () => {
    const md = file("宋楷.css", { "--theme-name": "宋楷", "--theme-kind": "markdown" });
    const r = buildUiRegistry([md, xuanzhi], both, DIR);
    expect(r.markdownFiles).toBe(1);
    expect(r.entries.map((e) => e.id)).toEqual(["paper", "night", "宣纸"]);
  });

  it("stands a missing card where a selected file would be, preference untouched", () => {
    const { entries } = buildUiRegistry([], { light: "宣纸", dark: "night" }, DIR);
    const m = entries.find((e) => e.id === "宣纸");
    expect(m).toMatchObject({ missing: true, usable: false, scheme: "light", fileName: "宣纸.css", path: `${DIR}/宣纸.css` });
  });

  it("carries the dropped rules and the kept count onto the card", () => {
    const f = file("冷灰.css", { "--theme-name": "冷灰", "--theme-scheme": "light" }, { "--color-sienna": "#555" }, [
      { rule: 2, selector: "body", reason: "越界" },
    ]);
    const { entries } = buildUiRegistry([f], both, DIR);
    expect(entries.find((e) => e.id === "冷灰")).toMatchObject({ usable: true, kept: 1, problems: [{ rule: 2 }] });
  });
});

describe("resolveUiTheme", () => {
  it("returns the selected entry when it is usable and of that polarity", () => {
    const { entries } = buildUiRegistry([xuanzhi], { light: "宣纸", dark: "night" }, DIR);
    expect(resolveUiTheme(entries, "light", "宣纸").id).toBe("宣纸");
  });

  it("falls back to the built-in for a missing, unusable or wrong-polarity id", () => {
    const { entries } = buildUiRegistry([mo, file("半调.css", {})], { light: "宣纸", dark: "墨" }, DIR);
    expect(resolveUiTheme(entries, "light", "宣纸").id).toBe("paper");
    expect(resolveUiTheme(entries, "light", "半调").id).toBe("paper");
    expect(resolveUiTheme(entries, "light", "墨").id).toBe("paper");
    expect(resolveUiTheme(entries, "dark", "墨").id).toBe("墨");
    expect(resolveUiTheme(entries, "dark", "nope").id).toBe("night");
  });
});

describe("helpers", () => {
  it("installs every usable user theme, never a built-in", () => {
    const { entries } = buildUiRegistry([mo, xuanzhi, file("半调.css", {})], both, DIR);
    expect(installableEntries(entries).map((e) => e.id)).toEqual(["墨", "宣纸"]);
  });

  it("counts usable cards, built-ins included", () => {
    const { entries } = buildUiRegistry([mo, file("半调.css", {})], { light: "gone", dark: "night" }, DIR);
    expect(usableCount(entries)).toBe(3);
  });

  it("names built-ins bilingually and user themes as written", () => {
    const { entries } = buildUiRegistry([xuanzhi], both, DIR);
    expect(displayThemeName(entries[0], true)).toBe("纸");
    expect(displayThemeName(entries[0], false)).toBe("Paper");
    expect(displayThemeName(entries[2], false)).toBe("宣纸");
  });
});
