/**
 * The typography-theme validator over the shape of a CSSRuleList — plain
 * objects here, the browser's own rules in the app (see validate.ts).
 */
import { describe, expect, it } from "vitest";
import {
  MD_SCOPE_PREFIX, REASON, isAllowedUrl, isMdSelector, splitSelectors, themeKindOf, validateMarkdownRules,
  validateThemeRules, type RuleLike,
} from "../theme/validate";
import { rewriteUrls } from "../theme/assets";

const P = MD_SCOPE_PREFIX;

function style(decls: Record<string, string>, important: string[] = []): RuleLike["style"] {
  const names = Object.keys(decls);
  return {
    length: names.length,
    item: (i) => names[i],
    getPropertyValue: (n) => decls[n] ?? "",
    getPropertyPriority: (n) => (important.includes(n) ? "important" : ""),
  };
}
const rule = (selectorText: string, decls: Record<string, string>, important?: string[]): RuleLike =>
  ({ type: 1, selectorText, style: style(decls, important) });
const media = (conditionText: string, cssRules: RuleLike[]): RuleLike =>
  ({ type: 4, conditionText, cssText: `@media ${conditionText} { }`, cssRules });
const fontFace = (decls: Record<string, string>): RuleLike => ({ type: 5, cssText: "@font-face { }", style: style(decls) });
const keyframes: RuleLike = { type: 7, cssText: "@keyframes fade { from { opacity: 0; } to { opacity: 1; } }" };

const contract = { scale: [], core: ["--color-sienna"], derived: [] };

describe("selector fence", () => {
  it("accepts selectors that start at .md-body and nothing else", () => {
    for (const ok of [".md-body", ".md-body h1", ".md-body > p", ".md-body.wide", ".md-body:hover", ".md-body h2::after"]) {
      expect(isMdSelector(ok)).toBe(true);
    }
    for (const bad of ["body", ".md-body-x", "html .md-body", ":root", ".editor .md-body", "h1"]) {
      expect(isMdSelector(bad)).toBe(false);
    }
  });

  // 回归：围栏有两半，「从 .md-body 开始」只是第一半。`~` / `+` 从它开始却往旁边
  // 走，选中的是预览容器的**兄弟**——那是应用界面；而排版主题可以由项目目录提供，
  // 并按 id 顶掉用户自己的同名主题，所以这不只是作者自找的。
  it("refuses sibling combinators that walk back out of .md-body", () => {
    for (const bad of [".md-body ~ *", ".md-body + .toolbar", ".md-body~div", ".md-body h1 + .chrome"]) {
      expect(isMdSelector(bad)).toBe(false);
    }
    // 括号 / 方括号里的 + 和 ~ 不是组合器。
    for (const ok of [".md-body li:nth-child(2n+1)", ".md-body [rel~='tag']", ".md-body:has(+ .x)"]) {
      expect(isMdSelector(ok)).toBe(true);
    }
  });

  it("names the combinator refusal separately from the out-of-bounds one", () => {
    const out = validateMarkdownRules([
      rule(".md-body ~ *", { display: "none" }),
      rule(".editor", { display: "none" }),
    ]);
    expect(out.css).toBe("");
    expect(out.problems.map((p) => p.reason)).toEqual(["mdCombinator", "mdSelector"]);
  });

  it("splits a selector list on top-level commas only", () => {
    expect(splitSelectors(".md-body h1, .md-body :is(h2, h3), .md-body [title='a,b']"))
      .toEqual([".md-body h1", ".md-body :is(h2, h3)", ".md-body [title='a,b']"]);
  });
});

describe("url() policy", () => {
  it("allows relative paths and data:, refuses schemes, absolute and traversal", () => {
    expect(isAllowedUrl("宋楷/kai.woff2")).toBe(true);
    expect(isAllowedUrl("./tex.png")).toBe(true);
    expect(isAllowedUrl("data:font/woff2;base64,AAAA")).toBe(true);
    expect(isAllowedUrl("https://evil.example/k?x")).toBe(false);
    expect(isAllowedUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedUrl("/etc/passwd")).toBe(false);
    expect(isAllowedUrl("../../secrets.png")).toBe(false);
    expect(isAllowedUrl("")).toBe(false);
  });

  it("rewrites relative urls only, through the injected resolver", () => {
    const css = `src: url("kai.woff2"), url(data:font/woff2;base64,AA), url('https://x/y'); background: url(tex.png)`;
    expect(rewriteUrls(css, (t) => `R:${t}`))
      .toBe(`src: url("R:kai.woff2"), url(data:font/woff2;base64,AA), url('https://x/y'); background: url("R:tex.png")`);
  });
});

describe("validateMarkdownRules", () => {
  it("keeps fenced rules, regenerates them, and reads the header off :root", () => {
    const r = validateMarkdownRules([
      rule(":root", { "--theme-name": " 宋楷", "--theme-kind": "markdown" }),
      rule(".md-body", { "--md-line": "1.9", "--md-font-body": "var(--font-serif)" }),
      rule(".md-body h1, .md-body h2", { "font-weight": "300" }, ["font-weight"]),
    ]);
    expect(r.meta).toEqual({ "--theme-name": "宋楷", "--theme-kind": "markdown" });
    expect(r.css).toBe(`${P} .md-body { --md-line: 1.9; --md-font-body: var(--font-serif); }\n\n${P} .md-body h1, ${P} .md-body h2 { font-weight: 300 !important; }`);
    expect(r.kept).toBe(2);
    expect(r.problems).toEqual([]);
    expect(r.ownFonts).toBe(false);
    expect(r.ownColors).toBe(false);
  });

  it("drops rules outside the fence, and colours written on :root, each with its reason", () => {
    const r = validateMarkdownRules([
      rule(":root", { "--theme-name": "x", "--md-color-text": "#000" }),
      rule("body", { background: "red" }),
      rule(".md-body p, h1", { margin: "0" }),
      rule(".md-body", { color: "#222" }),
    ]);
    expect(r.problems).toEqual([
      { rule: 1, selector: ":root --md-color-text", reason: REASON.mdRoot },
      { rule: 2, selector: "body", reason: REASON.mdSelector },
      { rule: 3, selector: ".md-body p, h1", reason: REASON.mdSelector },
    ]);
    expect(r.css).toBe(`${P} .md-body { color: #222; }`);
    expect(r.ownColors).toBe(true);
  });

  it("recurses into @media / @supports / @container with the same fence, numbering by the top-level rule", () => {
    const r = validateMarkdownRules([
      media("(max-width: 600px)", [rule(".md-body", { "--md-scale": "0.9" }), rule("body", { margin: "0" })]),
      { type: 12, cssText: "@supports (display: grid) { }", cssRules: [rule("body", { display: "grid" })] },
      { type: 0, cssText: "@container (min-width: 400px) { }", cssRules: [rule(".md-body h1", { "font-size": "2em" })] },
    ]);
    expect(r.css).toBe(
      `@media (max-width: 600px) {\n${P} .md-body { --md-scale: 0.9; }\n}\n\n@container (min-width: 400px) {\n${P} .md-body h1 { font-size: 2em; }\n}`,
    );
    expect(r.kept).toBe(2);
    expect(r.problems).toEqual([
      { rule: 1, selector: "body", reason: REASON.mdSelector },
      { rule: 2, selector: "body", reason: REASON.mdSelector },
    ]);
  });

  it("keeps @font-face and @keyframes, collects assets, and marks own fonts", () => {
    const r = validateMarkdownRules([
      fontFace({ "font-family": "Kai", src: 'url("宋楷/kai.woff2") format("woff2")' }),
      keyframes,
      rule(".md-body", { "font-family": "Kai, serif", background: "url(宋楷/paper.png)" }),
    ]);
    expect(r.ownFonts).toBe(true);
    expect(r.ownColors).toBe(true);
    expect(r.assets).toEqual(["宋楷/kai.woff2", "宋楷/paper.png"]);
    expect(r.css).toContain('@font-face { font-family: Kai; src: url("宋楷/kai.woff2") format("woff2"); }');
    expect(r.css).toContain(keyframes.cssText);
    expect(r.kept).toBe(3);
  });

  it("drops a declaration whose url() is remote or absolute, keeps its siblings", () => {
    const r = validateMarkdownRules([
      rule(".md-body", { background: "url(https://evil.example/tex.png)", color: "#111" }),
      fontFace({ "font-family": "X", src: "url(/etc/passwd)" }),
    ]);
    expect(r.css).toBe(`${P} .md-body { color: #111; }`);
    expect(r.problems).toEqual([
      { rule: 1, selector: ".md-body background", reason: REASON.mdUrl },
      { rule: 2, selector: "@font-face src", reason: REASON.mdUrl },
    ]);
  });

  it("refuses @import and other at-rules", () => {
    const r = validateMarkdownRules([{ type: 3, cssText: '@import url("x.css");' }, { type: 0, cssText: "@layer a { }" }]);
    expect(r.problems.map((p) => p.reason)).toEqual([REASON.mdAtRule, REASON.mdAtRule]);
    expect(r.problems[0].selector).toBe('@import url("x.css");');
  });

  it("scopes every kept selector so the file beats the base it extends", () => {
    // `[data-md-theme="manuscript"] .md-body` (0,1,1) would otherwise beat the
    // file's `.md-body` (0,1,0) whatever the source order.
    const r = validateMarkdownRules([rule(".md-body, .md-body > p", { "--md-line": "1.9" })]);
    expect(r.css.startsWith(`${P} .md-body, ${P} .md-body > p {`)).toBe(true);
  });

  it("emits the engine's own serialisation when the style offers it — shorthands restored, refused declarations gone", () => {
    // The CSSOM enumerates `background: #fff` as eight longhands but
    // serialises the block back with the shorthand; the walker judges per
    // longhand, removes what it refused, and emits `cssText`.
    const decls: Record<string, string> = {
      "--theme-name": "x", "background-color": "#fff", "background-image": "url(https://x/y.png)", color: "#111",
    };
    const engineStyle: RuleLike["style"] = {
      get length() { return Object.keys(decls).length; },
      item: (i) => Object.keys(decls)[i],
      getPropertyValue: (n) => decls[n] ?? "",
      getPropertyPriority: () => "",
      removeProperty: (n) => { const v = decls[n]; delete decls[n]; return v; },
      get cssText() { return "background: #fff; color: #111;"; },
    };
    const r = validateMarkdownRules([{ type: 1, selectorText: ".md-body", style: engineStyle }]);
    expect(r.css).toBe(`${P} .md-body { background: #fff; color: #111; }`);
    expect(r.meta).toEqual({ "--theme-name": "x" });
    expect(Object.keys(decls)).toEqual(["background-color", "color"]);
    expect(r.problems).toEqual([{ rule: 1, selector: ".md-body background-image", reason: REASON.mdUrl }]);
  });

  it("does not count a var()-based font or colour as the theme's own", () => {
    const r = validateMarkdownRules([rule(".md-body", { "--md-font-body": "var(--font-sans)", "--md-color-accent": "var(--color-amber)" })]);
    expect(r.ownFonts).toBe(false);
    expect(r.ownColors).toBe(false);
  });
});

describe("kind dispatch", () => {
  it("reads --theme-kind before choosing a validator", () => {
    const mdRules = [rule(":root", { "--theme-name": "x", "--theme-kind": '"markdown"' }), rule(".md-body", { color: "#000" })];
    const uiRules = [rule(":root", { "--theme-name": "x", "--theme-scheme": "light", "--color-sienna": "#000" })];
    expect(themeKindOf(mdRules)).toBe("markdown");
    expect(themeKindOf(uiRules)).toBe("ui");
    expect(validateThemeRules(mdRules, "x", contract).kind).toBe("markdown");
    const asUi = validateThemeRules(uiRules, "x", contract);
    expect(asUi.kind).toBe("ui");
    if (asUi.kind === "ui") expect(asUi.tokens).toEqual({ "--color-sienna": "#000" });
  });
});
