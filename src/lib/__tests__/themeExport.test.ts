import { describe, expect, it } from "vitest";
import { TOKEN_CONTRACT } from "../theme/contractData";
import { exportPaletteCss, referencedTokens, resolveTokenValue } from "../theme/export";
import { LEAD_TOKENS, themeFileText } from "../theme/exportFile";
import { BUILTIN_UI_THEMES, buildUiRegistry, type ThemeEntry } from "../theme/registry";
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
const user: ThemeEntry = buildUiRegistry(
  [{
    fileName: "宣纸.css", path: "/t/宣纸.css",
    validation: {
      meta: { "--theme-name": "宣纸", "--theme-scheme": "light" },
      tokens: { "--color-bg-base": "#F3EEE3", "--color-accent-tint": "rgba(1, 2, 3, 0.1)" },
      problems: [], kept: 2,
    },
  }],
  { light: "宣纸", dark: "night" },
  "/t",
).entries.find((e) => e.id === "宣纸") as ThemeEntry;

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
