import { describe, expect, it } from "vitest";
import { cleanMetaValue, readThemeMeta, themeIdFromFileName } from "../theme/manifest";

describe("theme id from file name", () => {
  it("is the file name without .css", () => {
    expect(themeIdFromFileName("宣纸.css")).toBe("宣纸");
    expect(themeIdFromFileName("cold-grey.css")).toBe("cold-grey");
  });

  it("refuses anything that is not a named .css file", () => {
    expect(themeIdFromFileName("readme.md")).toBeNull();
    expect(themeIdFromFileName(".css")).toBeNull();
    expect(themeIdFromFileName(".hidden.css")).toBeNull();
    expect(themeIdFromFileName("  .css")).toBeNull();
  });
});

describe("metadata values", () => {
  it("drops the CSSOM's leading space and one layer of quotes", () => {
    expect(cleanMetaValue(" 宣纸")).toBe("宣纸");
    expect(cleanMetaValue('"Cold Grey"')).toBe("Cold Grey");
    expect(cleanMetaValue("'x'")).toBe("x");
    expect(cleanMetaValue('"unbalanced')).toBe('"unbalanced');
  });
});

describe("readThemeMeta", () => {
  it("reads a complete ui manifest", () => {
    const r = readThemeMeta({
      "--theme-name": " 宣纸",
      "--theme-scheme": "light",
      "--theme-extends": "paper",
      "--theme-version": "2",
      "--theme-author": "某某",
    });
    expect(r.problems).toEqual([]);
    expect(r.meta).toEqual({ name: "宣纸", kind: "ui", scheme: "light", extends: "paper", version: "2", author: "某某" });
  });

  it("defaults kind to ui and extends to the scheme's built-in", () => {
    const r = readThemeMeta({ "--theme-name": "墨", "--theme-scheme": "dark" });
    expect(r.meta?.kind).toBe("ui");
    expect(r.meta?.extends).toBe("night");
  });

  it("cannot use a ui theme without a name or a scheme — the one 「读不出」 case", () => {
    expect(readThemeMeta({ "--theme-scheme": "light" }).meta).toBeUndefined();
    expect(readThemeMeta({ "--theme-name": "x" }).meta).toBeUndefined();
    expect(readThemeMeta({ "--theme-name": "x", "--theme-scheme": "blue" }).meta).toBeUndefined();
    const r = readThemeMeta({});
    expect(r.problems).toEqual([{ rule: 1, selector: ":root", reason: "缺 --theme-name / --theme-scheme" }]);
  });

  it("corrects an extends of the other polarity and says so", () => {
    const r = readThemeMeta({ "--theme-name": "x", "--theme-scheme": "light", "--theme-extends": "night" });
    expect(r.meta?.extends).toBe("paper");
    expect(r.problems.map((p) => p.selector)).toEqual(["--theme-extends"]);
  });

  it("reads a markdown theme without a scheme", () => {
    const r = readThemeMeta({ "--theme-name": "宋楷", "--theme-kind": "markdown" });
    expect(r.meta).toEqual({ name: "宋楷", kind: "markdown", extends: "manuscript" });
  });

  it("treats an unknown kind as ui and notes it", () => {
    const r = readThemeMeta({ "--theme-name": "x", "--theme-kind": "skin", "--theme-scheme": "dark" });
    expect(r.meta?.kind).toBe("ui");
    expect(r.problems).toHaveLength(1);
  });
});
