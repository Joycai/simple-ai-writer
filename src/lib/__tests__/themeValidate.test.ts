/**
 * The validator walks the shape of a CSSRuleList; there is no CSSOM in node,
 * so the rules here are plain objects of that shape (`RuleLike`).
 */
import { describe, expect, it } from "vitest";
import { REASON, isThemeSelector, uiThemeCss, validateUiRules, type RuleLike } from "../theme/validate";

const contract = {
  scale: ["--radius-md", "--space-4", "--font-serif"],
  core: ["--color-bg-base", "--color-sienna", "--color-text-primary"],
  derived: ["--color-accent", "--stg-accent"],
};

function style(decls: Record<string, string>): RuleLike["style"] {
  const names = Object.keys(decls);
  return {
    length: names.length,
    item: (i) => names[i],
    getPropertyValue: (n) => decls[n] ?? "",
  };
}

const rule = (selectorText: string, decls: Record<string, string>): RuleLike => ({ type: 1, selectorText, style: style(decls) });
const media = (conditionText: string): RuleLike => ({ type: 4, conditionText, cssText: `@media ${conditionText} { }` });

describe("theme selector", () => {
  it("accepts :root and the theme's own key, nothing else", () => {
    expect(isThemeSelector(":root", "x")).toBe(true);
    expect(isThemeSelector('[data-theme="x"]', "x")).toBe(true);
    expect(isThemeSelector("[data-theme='x']", "x")).toBe(true);
    expect(isThemeSelector('[data-theme="y"]', "x")).toBe(false);
    expect(isThemeSelector("html", "x")).toBe(false);
    expect(isThemeSelector("body", "x")).toBe(false);
  });
});

describe("validateUiRules", () => {
  it("keeps contract tokens, lifts --theme-* into meta, counts what it kept", () => {
    const r = validateUiRules(
      [rule(":root", { "--theme-name": " 宣纸", "--theme-scheme": "light", "--color-bg-base": " #F3EEE3", "--color-accent": "var(--color-sienna)" })],
      "宣纸",
      contract,
    );
    expect(r.meta).toEqual({ "--theme-name": "宣纸", "--theme-scheme": "light" });
    expect(r.tokens).toEqual({ "--color-bg-base": "#F3EEE3", "--color-accent": "var(--color-sienna)" });
    expect(r.kept).toBe(2);
    expect(r.problems).toEqual([]);
  });

  it("drops a scale token, an unknown token and a plain property, each with its reason", () => {
    const r = validateUiRules(
      [rule(":root", { "--radius-md": "4px", "--color-danger": "red", "display": "none", "--color-sienna": "#000" })],
      "x",
      contract,
    );
    expect(r.tokens).toEqual({ "--color-sienna": "#000" });
    expect(r.problems).toEqual([
      { rule: 1, selector: ":root --radius-md", reason: REASON.scale },
      { rule: 1, selector: ":root --color-danger", reason: REASON.unknown },
      { rule: 1, selector: ":root display", reason: REASON.property },
    ]);
  });

  it("drops whole rules on any other selector, numbered by their place in the file", () => {
    const r = validateUiRules(
      [
        rule(":root", { "--color-sienna": "#000" }),
        rule("body", { "--color-sienna": "#111", background: "red" }),
        rule(".editor .cm-content", { "font-size": "18px" }),
      ],
      "x",
      contract,
    );
    expect(r.tokens).toEqual({ "--color-sienna": "#000" });
    expect(r.problems).toEqual([
      { rule: 2, selector: "body", reason: REASON.selector },
      { rule: 3, selector: ".editor .cm-content", reason: REASON.selector },
    ]);
  });

  it("refuses prefers-color-scheme with the reason that matters, other at-rules as out of bounds", () => {
    const r = validateUiRules(
      [media("(prefers-color-scheme: dark)"), { type: 5, cssText: "@font-face { }" }],
      "x",
      contract,
    );
    expect(r.problems.map((p) => p.reason)).toEqual([REASON.schemeMedia, REASON.atRule]);
    expect(r.problems[1].selector).toBe("@font-face");
  });

  it("lets a later declaration win, as the cascade would", () => {
    const r = validateUiRules(
      [rule(":root", { "--color-sienna": "#000" }), rule('[data-theme="x"]', { "--color-sienna": "#fff" })],
      "x",
      contract,
    );
    expect(r.tokens["--color-sienna"]).toBe("#fff");
  });
});

describe("uiThemeCss", () => {
  it("regenerates one block on the theme's own key, id escaped", () => {
    expect(uiThemeCss('a"b', { "--color-sienna": "#000", "--color-bg-base": "#fff" })).toBe(
      '[data-theme="a\\"b"] {\n  --color-sienna: #000;\n  --color-bg-base: #fff;\n}',
    );
  });
});
