import { describe, expect, it } from "vitest";
import { TOKEN_CONTRACT } from "../theme/contractData";
import { exportPaletteCss, referencedTokens, resolveTokenValue } from "../theme/export";
import { LEAD_TOKENS, themeFileText } from "../theme/exportFile";
import { BUILTIN_MARKDOWN_THEMES, BUILTIN_UI_THEMES, buildRegistry, type ThemeEntry } from "../theme/registry";
import { sampleDocument } from "../theme/sample";
import { markdownThemeCss } from "../theme/markdownThemes";

declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
};
declare const process: { cwd(): string };
const fs = require("node:fs");
const read = (rel: string): string => fs.readFileSync(`${process.cwd()}/${rel}`, "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(`${process.cwd()}/${dir}`, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const [paper, night] = BUILTIN_UI_THEMES;
const user: ThemeEntry = buildRegistry(
  [{
    fileName: "宣纸.css", path: "/t/宣纸.css",
    validation: {
      kind: "ui",
      meta: { "--theme-name": "宣纸", "--theme-scheme": "light" },
      tokens: { "--color-bg-base": "#F3EEE3", "--color-accent-tint": "rgba(1, 2, 3, 0.1)" },
      problems: [], kept: 2,
    },
  }],
  [],
  { light: "宣纸", dark: "night", markdown: "manuscript" },
  { user: "/t" },
).ui.find((e) => e.id === "宣纸") as ThemeEntry;

describe("resolveTokenValue", () => {
  it("prefers the file's own token, then the built-in hand-tune, then derive defaults, then the base", () => {
    expect(resolveTokenValue(user, "light", "--color-bg-base", TOKEN_CONTRACT)).toBe("#F3EEE3");
    expect(resolveTokenValue(user, "light", "--color-sienna", TOKEN_CONTRACT)).toBe(TOKEN_CONTRACT.coreValues.light["--color-sienna"]);
    expect(resolveTokenValue(paper, "light", "--color-accent-tint", TOKEN_CONTRACT)).toBe(TOKEN_CONTRACT.handTuned.paper["--color-accent-tint"]);
    expect(resolveTokenValue(user, "light", "--stg-accent", TOKEN_CONTRACT)).toBe(TOKEN_CONTRACT.deriveDefaults.root["--stg-accent"]);
    expect(resolveTokenValue(user, "light", "--stg-bg", TOKEN_CONTRACT)).toBe(TOKEN_CONTRACT.deriveDefaults.light["--stg-bg"]);
  });
});

describe("exportPaletteCss", () => {
  const md = markdownThemeCss("wechat", "body");
  const css = exportPaletteCss(paper, night, md, TOKEN_CONTRACT);

  it("declares both polarities and lets the reader's browser choose", () => {
    expect(css).toMatch(/^:root \{\n  color-scheme: light dark;/);
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(`--color-bg-base: ${TOKEN_CONTRACT.coreValues.light["--color-bg-base"]};`);
    expect(css).toContain(`--color-bg-base: ${TOKEN_CONTRACT.coreValues.dark["--color-bg-base"]};`);
  });

  it("carries the whole core and only the derived tokens the markdown CSS references", () => {
    for (const name of TOKEN_CONTRACT.core) expect(css).toContain(`${name}:`);
    expect(referencedTokens(md).has("--color-accent-tint")).toBe(true);
    expect(css).toContain(`--color-accent-tint: ${TOKEN_CONTRACT.handTuned.paper["--color-accent-tint"]};`);
    expect(css).not.toContain("--stg-accent:");
    expect(css).not.toContain("--lore-");
  });

  it("resolves every var() the exported style references", () => {
    const full = `${css}\n${md}`;
    const declared = new Set([...full.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const dangling = [...referencedTokens(full)].filter((n) => !declared.has(n) && !n.startsWith("--md-") && !n.startsWith("--font-"));
    expect(dangling).toEqual([]);
  });

  it("puts the author's user theme into the file", () => {
    const withUser = exportPaletteCss(user, night, md, TOKEN_CONTRACT);
    expect(withUser).toContain("--color-bg-base: #F3EEE3;");
    expect(withUser).toContain("--color-accent-tint: rgba(1, 2, 3, 0.1);");
  });

  it("pins one polarity, with no media block, when asked", () => {
    const one = exportPaletteCss(paper, night, md, TOKEN_CONTRACT, "dark");
    expect(one).toContain("color-scheme: dark;");
    expect(one).not.toContain("prefers-color-scheme");
    expect(one).toContain(`--color-bg-base: ${TOKEN_CONTRACT.coreValues.dark["--color-bg-base"]};`);
    expect(one).not.toContain(`--color-bg-base: ${TOKEN_CONTRACT.coreValues.light["--color-bg-base"]};`);
  });

  it("has retired the hand-copied palette for good", () => {
    const offenders = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__") && read(f).includes("EXPORT_TOKEN_CSS"));
    expect(offenders).toEqual([]);
  });
});

describe("themeFileText — 把当前主题导出为文件", () => {
  const text = themeFileText(paper, TOKEN_CONTRACT, true);

  it("is a complete, annotated ui theme the validator reads straight back", () => {
    expect(text).toContain("--theme-name: 纸-副本;");
    expect(text).toContain("--theme-scheme: light;");
    expect(text).toContain("--theme-extends: paper;");
    for (const name of TOKEN_CONTRACT.core) {
      expect(text).toContain(`  ${name}: ${TOKEN_CONTRACT.coreValues.light[name]};`);
    }
    // One block, on :root — what an author writes by instinct.
    expect(text.match(/\{/g)).toHaveLength(1);
    expect(text).toMatch(/^:root \{/m);
  });

  it("leads with the six roles the design shows, in its order, each with its role", () => {
    const order = LEAD_TOKENS.map((l) => text.indexOf(`  ${l.name}:`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.indexOf("--color-bg-surface:")).toBeGreaterThan(order[5]);
    expect(text).toContain("/* 唯一强调色 · 选中、链接、进度 */");
  });

  it("exports a user theme with its own values over the base", () => {
    const t = themeFileText(user, TOKEN_CONTRACT, false);
    expect(t).toContain("--theme-name: 宣纸-copy;");
    expect(t).toContain("--color-bg-base: #F3EEE3;");
    expect(t).toContain(`--color-sienna: ${TOKEN_CONTRACT.coreValues.light["--color-sienna"]};`);
  });
});

describe("sampleDocument — the typography card's frame", () => {
  const manuscript = BUILTIN_MARKDOWN_THEMES[0];
  const file: ThemeEntry = {
    id: "宋楷", kind: "markdown", name: "宋楷", extends: "clean", source: "user", path: "/t/宋楷.css",
    problems: [], kept: 1, usable: true, css: ".md-body { --md-font-body: Kaiti; }", assets: [], ownFonts: true,
  };

  it("carries the appearance in force under one polarity, the base, and the file's CSS", () => {
    const doc = sampleDocument(file, ".md-body { --md-font-body: Kaiti; }", night, "dark", true);
    expect(doc).toContain("color-scheme: dark;");
    expect(doc).not.toContain("prefers-color-scheme");
    expect(doc).toContain(`--color-bg-base: ${TOKEN_CONTRACT.coreValues.dark["--color-bg-base"]};`);
    // The base it extends, scoped to body, then the file's own rules after it.
    expect(doc).toContain("--md-font-body: var(--font-sans)");
    expect(doc.indexOf("--md-font-body: Kaiti")).toBeGreaterThan(doc.indexOf("--md-font-body: var(--font-sans)"));
    expect(doc).toContain('<html data-md-theme="clean">');
    expect(doc).toContain('<body class="md-body"><h2>第三章 · 渡口</h2>');
    expect(doc).toContain("<blockquote>");
  });

  it("gives a built-in its own base and no user sheet", () => {
    const doc = sampleDocument(manuscript, "", paper, "light", false);
    expect(doc).toContain("--md-para-indent: 2em");
    expect(doc).toContain("<h2>Chapter Three</h2>");
  });

  it("escapes the sample text", () => {
    expect(sampleDocument(manuscript, "", paper, "light", true)).not.toMatch(/<script/i);
  });
});
