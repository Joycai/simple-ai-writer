/**
 * Theme parity for design tokens, and token-only colour in the snippet surfaces.
 *
 * `tokens.css` has three blocks — `:root` (theme-independent scales), and one
 * each for `[data-theme="light"]` / `[data-theme="dark"]`. Several section
 * comments (`扮演面板`, `设置页色系`, `设定集`, `AI 面板设计语言`) appear in
 * **more than one** of them, so a new block inserted next to "the" anchor can
 * silently land in the wrong theme. That happened to the whole `--snip-*` family:
 * its dark values were appended inside the *light* block, where they overrode the
 * light ones and left the dark block with nothing. Nothing threw, no screenshot
 * looked wrong, and the light theme quietly rendered dark chrome.
 *
 * The invariant that catches it in one line: a custom property is either
 * theme-independent (defined in `:root`) or defined in **both** theme blocks.
 * One theme alone is always a mistake.
 *
 * The second test pins the other half of "it must be themed": the snippet
 * surfaces spell every colour as a token, so there is nothing left that *could*
 * be theme-blind. It also covers the context menu, whose styles the snippet save
 * flow borrows rather than re-declares.
 */
import { describe, expect, it } from "vitest";

/**
 * Stylesheets are read from disk rather than imported.
 *
 * `import.meta.glob(..., {query: "?raw"})` — the trick
 * `profileSystemPrompt.test.ts` uses for `.ts` sources — comes back **empty** for
 * `.css`: vitest stubs the CSS pipeline, and `?raw` does not escape it. Since the
 * project's tsconfig carries no `@types/node`, a bare `node:fs` import would run
 * fine here and then fail `tsc --noEmit` in CI, so the two functions this test
 * needs are declared inline.
 */
declare const require: (m: string) => { readFileSync(p: string, enc: string): string };
declare const process: { cwd(): string };

const read = (rel: string): string =>
  require("node:fs").readFileSync(`${process.cwd()}/${rel}`, "utf8");

const tokens = read("src/styles/tokens.css");

/** The body of one top-level rule, up to the closing brace in column 0. */
function ruleBody(selector: string): string {
  const start = tokens.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in tokens.css`);
  const end = tokens.indexOf("\n}", start);
  return tokens.slice(start, end);
}

function declared(body: string): Set<string> {
  return new Set([...body.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
}

describe("tokens.css theme parity", () => {
  const root = declared(ruleBody(":root"));
  const light = declared(ruleBody('[data-theme="light"]'));
  const dark = declared(ruleBody('[data-theme="dark"]'));

  it("has no token that only one theme defines", () => {
    const lightOnly = [...light].filter((t) => !dark.has(t) && !root.has(t)).sort();
    const darkOnly = [...dark].filter((t) => !light.has(t) && !root.has(t)).sort();
    expect({ lightOnly, darkOnly }).toEqual({ lightOnly: [], darkOnly: [] });
  });

  it("defines the snippet family in both themes", () => {
    const snip = [...light, ...dark, ...root].filter((t) => t.startsWith("--snip-"));
    expect(snip.length).toBeGreaterThan(0);
    for (const t of new Set(snip)) {
      expect(light.has(t) || root.has(t), `${t} missing from the light theme`).toBe(true);
      expect(dark.has(t) || root.has(t), `${t} missing from the dark theme`).toBe(true);
    }
  });

  it("gives the two themes different snippet values", () => {
    // A family copied into both blocks unchanged would pass the test above while
    // still rendering dark chrome on paper.
    const grab = (body: string) => body.match(/--snip-rule:\s*([^;]+);/)?.[1].trim();
    expect(grab(ruleBody('[data-theme="light"]'))).not.toBe(grab(ruleBody('[data-theme="dark"]')));
  });
});

describe("snippet surfaces are token-only", () => {
  const sheets = [
    "src/components/ai/SnippetPicker.module.css",
    "src/components/ai/SnippetSaveMenu.module.css",
    "src/components/settings/panes/Prompts.module.css",
    // Borrowed by the save flow's right-click menu — a raw colour here would be
    // theme-blind in exactly the same way.
    "src/components/common/ContextMenu.module.css",
  ];

  it.each(sheets)("%s spells every colour as a token", (path) => {
    const css = read(path).replace(/\/\*[\s\S]*?\*\//g, "");
    const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? [];
    expect(literals).toEqual([]);
  });
});
