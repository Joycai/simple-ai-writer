import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_CONTENT_THEMES, CONTENT_TOKENS, contentCompatibleCss, contentPaletteCss, resolveContentTheme } from "../contentColors";
import { validateContentRules, type RuleLike } from "../validate";
import { buildRegistry, type ScannedThemeFile } from "../registry";
import { ensureSelectedLoaded, fileBackedIds, selectedContentCss } from "../install";

function rule(selector: string, values: Record<string,string>): RuleLike {
  const names = Object.keys(values);
  return { type: 1, selectorText: selector, style: { length: names.length, item: (i) => names[i], getPropertyValue: (n) => values[n] } };
}
const selected = { light: "paper", dark: "night", markdown: "clean" };
function file(name: string, bg: string): ScannedThemeFile {
  return { fileName: `${name}.css`, path: `/themes/${name}.css`, validation: validateContentRules([rule(":root", {
    "--theme-name": name, "--theme-kind": "markdown-color", "--theme-scheme": "light", "--md-color-bg": bg,
  })], name) };
}

describe("independent content colours", () => {
  it("ships both complete Morandi palettes from the example source", () => {
    for (const entry of BUILTIN_CONTENT_THEMES) {
      expect(Object.keys(entry.tokens!).sort()).toEqual([...CONTENT_TOKENS].sort());
      const source = readFileSync(new URL(`../../../../themes/${entry.id}.css`, import.meta.url), "utf8");
      expect(entry.tokens).toEqual(Object.fromEntries([...source.matchAll(/(--md-color-[\w-]+):\s*(#[\da-f]+)/gi)].map((m) => [m[1],m[2]])));
    }
    expect(BUILTIN_CONTENT_THEMES[0].tokens?.["--md-color-bg"]).toBe("#FBFDFB");
    expect(BUILTIN_CONTENT_THEMES[1].tokens?.["--md-color-bg"]).toBe("#252925");
  });
  it("rejects UI tokens, selectors, at-rules, resources and variable dependencies", () => {
    const result = validateContentRules([
      rule(":root", { "--md-color-bg": "#ffffff", "--color-bg-base": "#000000", "--md-color-text": "var(--color-text-primary)", "--md-color-link": "url(https://example.com/x)", color: "red" }),
      rule("body", { "--md-color-bg": "#000000" }),
      { type: 4, conditionText: "screen", cssRules: [rule(":root", { "--md-color-bg": "#000000" })] },
    ], "custom");
    expect(result.tokens).toEqual({ "--md-color-bg": "#ffffff" });
    expect(result.problems).toHaveLength(6);
  });
  it("derives optional details from an old custom palette rather than UI colours", () => {
    const css = contentPaletteCss({ ...BUILTIN_CONTENT_THEMES[0], tokens: {
      "--md-color-border": "#123456", "--md-color-quote-bg": "#234567",
      "--md-color-h3": "#345678", "--md-color-link": "#456789",
    } });
    expect(css).toContain("--md-color-table-border: #123456;");
    expect(css).toContain("--md-color-heading-rule: #123456;");
    expect(css).toContain("--md-color-quote-bg-2: #234567;");
    expect(css).toContain("--md-color-quote-bg-3: #234567;");
    expect(css).toContain("--md-color-list-1: #345678;");
    expect(css).toContain("--md-color-link-decoration: #456789;");
  });
  it("accepts optional detail tokens without relaxing the UI colour fence", () => {
    const result = validateContentRules([rule(":root", {
      "--md-color-table-border": "#123456", "--md-color-quote-bg-2": "#234567",
      "--color-bg-raised": "#345678",
    })], "custom");
    expect(result.tokens).toEqual({ "--md-color-table-border": "#123456", "--md-color-quote-bg-2": "#234567" });
    expect(result.problems).toHaveLength(1);
  });
  it("maps typography variables while preserving the entire legacy fallback", () => {
    expect(contentCompatibleCss("color: var(--color-text-primary, var(--backup, #fff)); background: #123456;"))
      .toBe("color: var(--md-legacy-color-text-primary, var(--color-text-primary, var(--backup, #fff))); background: #123456;");
  });
  it("never declares UI tokens or applies rules outside content surfaces", () => {
    const css = contentPaletteCss(BUILTIN_CONTENT_THEMES[0]);
    expect(css).not.toMatch(/(?:^|[;{\n])\s*--color-[\w-]+\s*:/);
    expect(css).not.toContain(":root");
    expect(css).not.toContain("[data-theme=");
    expect(css).toContain("[data-md-surface]");
    expect(css).toContain("--md-legacy-color-text-primary: #403C3C;");
  });
  it("allows project content overrides without changing either UI or typography", () => {
    const registry = buildRegistry([file("custom", "#ffffff")], [file("custom", "#eeeeee")], selected, { user: "/user", project: "/project" });
    expect(registry.content?.filter((e) => e.id === "custom")).toHaveLength(1);
    expect(registry.content?.find((e) => e.id === "custom")?.tokens?.["--md-color-bg"]).toBe("#eeeeee");
    expect(registry.ui.some((e) => e.id === "custom")).toBe(false);
    expect(registry.markdown.some((e) => e.id === "custom")).toBe(false);
  });
  it("keeps missing selections and falls back to the requested polarity", () => {
    const registry = buildRegistry([], [], { ...selected, contentLight: "missing" }, { user: "/user" });
    expect(registry.content?.find((e) => e.id === "missing")).toMatchObject({ missing: true, usable: false });
    expect(resolveContentTheme(registry.content!, "missing", "light").id).toBe("content-light");
    expect(resolveContentTheme(registry.content!, "morandi-content-dark", "light").scheme).toBe("light");
    expect(contentPaletteCss(resolveContentTheme([], "missing", "dark"))).not.toContain("undefined");
  });
  it("preloads user content files independently of UI and typography names", () => {
    expect(fileBackedIds({ ...selected, contentLight: "clean", contentDark: "morandi-content-dark" })).toEqual(["clean"]);
  });
  it("keeps legacy mode unchanged and exports fixed versus adaptive colours", async () => {
    await ensureSelectedLoaded(selected);
    expect(selectedContentCss()).toBe("");
    await ensureSelectedLoaded({ ...selected, contentMode: "light" });
    expect(selectedContentCss(true)).toContain("#FBFDFB");
    expect(selectedContentCss(true)).not.toContain("prefers-color-scheme");
    await ensureSelectedLoaded({ ...selected, contentMode: "auto" });
    expect(selectedContentCss()).toContain('[data-scheme="dark"]');
    expect(selectedContentCss(true)).toContain("@media (prefers-color-scheme: dark)");
    await ensureSelectedLoaded(selected);
  });
});
