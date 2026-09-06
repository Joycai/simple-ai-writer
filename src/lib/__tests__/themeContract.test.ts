/**
 * The theme contract — the structure of `tokens.css` and the two rules that
 * make a theme file possible (docs/feature/theme-system-plan.md §4, §12).
 *
 * `tokens.css` is five cascade layers. The invariants a refactor can silently
 * break, and what breaking each one looks like on screen:
 *
 * - **Core parity**: `[data-scheme="light"]` and `[data-scheme="dark"]` declare
 *   the same set. A token in one base only means the other scheme falls to
 *   `initial`, and `var()` on `initial` is invalid at computed-value time —
 *   the property silently disappears. This is the old parity test's rule,
 *   which caught the whole `--snip-*` family landing in the wrong block.
 * - **Hand-tune parity**: `[data-theme="paper"]` and `[data-theme="night"]`
 *   declare the same set, and nothing in it is core or scale. A hand-tune in
 *   one theme only would make that theme differ from its derive default while
 *   the other doesn't — a one-theme bug again.
 * - **Every derived token has a default**: in `tokens.derive`, either on
 *   `:root` or in *both* scheme blocks. Otherwise a user theme that didn't
 *   write it gets nothing.
 * - **Scales are theme-independent**: no `--space/--radius/--font…` inside a
 *   `[data-*]` block.
 *
 * The **dangling-reference guard** below is the other half. Three PRs in one
 * week (e2e1588, 0d6f8d8, bb5c217) fixed `var(--color-danger)`,
 * `var(--color-red)` and `var(--color-text)` — names no block ever declared.
 * `var()` on an undeclared property is not an error anywhere: the declaration
 * is dropped at computed-value time, and the element paints with whatever it
 * inherits. Once the token list is a constant, "every var() resolves" is one
 * test, and it is also the list a theme file will be validated against.
 */
import { describe, expect, it } from "vitest";

/**
 * Stylesheets are read from disk rather than imported: vitest stubs the CSS
 * pipeline, and `?raw` does not escape it. The project's tsconfig carries no
 * `@types/node`, so the two node functions this test needs are declared
 * inline rather than imported (a bare `node:fs` import fails `tsc --noEmit`).
 */
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

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Custom-property names declared directly in `body` (nested blocks removed). */
function declared(body: string): Set<string> {
  const direct = body.replace(/[^{};]*\{[^{}]*\}/g, "");
  return new Set([...direct.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

interface Block { path: string[]; body: string }

/** Every rule block with the preludes enclosing it — enough to tell a layer apart. */
function blocks(css: string): Block[] {
  const s = stripComments(css);
  const out: Block[] = [];
  const stack: { prelude: string; start: number }[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") {
      let j = i - 1;
      while (j >= 0 && !"{};".includes(s[j])) j--;
      stack.push({ prelude: s.slice(j + 1, i).trim(), start: i + 1 });
    } else if (c === "}") {
      const top = stack.pop();
      if (!top) throw new Error("unbalanced braces in tokens.css");
      out.push({ path: [...stack.map((f) => f.prelude), top.prelude], body: s.slice(top.start, i) });
    }
  }
  return out;
}

const tokens = read("src/styles/tokens.css");
const all = blocks(tokens);
const inLayer = (name: string) => all.filter((b) => b.path[0] === `@layer ${name}`);
const named = (bs: Block[], selector: string) =>
  bs.filter((b) => b.path[b.path.length - 1] === selector && !b.path.some((p) => p.startsWith("@supports")));
const union = (bs: Block[]) => new Set(bs.flatMap((b) => [...declared(b.body)]));

const scale = union(named(inLayer("tokens.scale"), ":root"));
const coreLight = union(named(inLayer("tokens.scheme"), '[data-scheme="light"]'));
const coreDark = union(named(inLayer("tokens.scheme"), '[data-scheme="dark"]'));
const deriveRoot = union(named(inLayer("tokens.derive"), ":root"));
const deriveLight = union(named(inLayer("tokens.derive"), '[data-scheme="light"]'));
const deriveDark = union(named(inLayer("tokens.derive"), '[data-scheme="dark"]'));
const paper = union(named(inLayer("tokens.theme"), '[data-theme="paper"]'));
const night = union(named(inLayer("tokens.theme"), '[data-theme="night"]'));

const diff = (a: Set<string>, b: Set<string>) => [...a].filter((t) => !b.has(t)).sort();

describe("tokens.css layer structure", () => {
  it("declares the five layers once, in contract order", () => {
    expect(tokens).toMatch(/^@layer tokens\.scale, tokens\.derive, tokens\.scheme, tokens\.theme, tokens\.user;/m);
  });

  it("opens the layer blocks in the declared order", () => {
    // LightningCSS rewrites the leading statement into first-occurrence order
    // when it bundles, so the blocks must appear in the same order the
    // statement names — otherwise the shipped CSS has a different cascade
    // from the source. (Verified 2026-09-06: the statement was dropped and
    // re-emitted as `@layer tokens.user;` after the last block.)
    const firstAt = (name: string) => stripComments(tokens).indexOf(`@layer ${name} {`);
    const order = ["tokens.scale", "tokens.derive", "tokens.scheme", "tokens.theme"].map(firstAt);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("has no legacy [data-theme=light|dark] selector left", () => {
    expect(stripComments(tokens)).not.toMatch(/\[data-theme="(light|dark)"\]/);
  });

  it("populates every layer it names", () => {
    for (const s of [scale, coreLight, coreDark, deriveRoot, deriveLight, deriveDark, paper, night]) {
      expect(s.size).toBeGreaterThan(0);
    }
  });
});

describe("core contract (tokens.scheme)", () => {
  it("is the same set in both bases", () => {
    expect({ lightOnly: diff(coreLight, coreDark), darkOnly: diff(coreDark, coreLight) })
      .toEqual({ lightOnly: [], darkOnly: [] });
  });

  it("never re-declares a scale token", () => {
    expect([...coreLight].filter((t) => scale.has(t))).toEqual([]);
  });

  it("is not also derived — a token is core or derived, never both", () => {
    const derivedAll = new Set([...deriveRoot, ...deriveLight, ...deriveDark, ...paper, ...night]);
    expect([...coreLight].filter((t) => derivedAll.has(t)).sort()).toEqual([]);
  });
});

describe("built-in hand-tunes (tokens.theme)", () => {
  it("are the same set in paper and night", () => {
    expect({ paperOnly: diff(paper, night), nightOnly: diff(night, paper) })
      .toEqual({ paperOnly: [], nightOnly: [] });
  });

  it("never touch a scale token", () => {
    expect([...paper].filter((t) => scale.has(t))).toEqual([]);
  });

  it("give the two themes different snippet values", () => {
    // A family copied into both blocks unchanged would pass parity while still
    // rendering dark chrome on paper.
    const grab = (sel: string) =>
      named(inLayer("tokens.theme"), sel).map((b) => b.body).join("").match(/--snip-rule:\s*([^;]+);/)?.[1].trim();
    expect(grab('[data-theme="paper"]')).toBeDefined();
    expect(grab('[data-theme="paper"]')).not.toBe(grab('[data-theme="night"]'));
  });
});

describe("derive defaults (tokens.derive)", () => {
  const derived = new Set([...deriveRoot, ...deriveLight, ...deriveDark, ...paper, ...night]);

  it("cover every derived token — on :root or in both scheme blocks", () => {
    const uncovered = [...derived]
      .filter((t) => !deriveRoot.has(t) && !(deriveLight.has(t) && deriveDark.has(t)))
      .sort();
    expect(uncovered).toEqual([]);
  });

  it("keep scheme-keyed defaults symmetric", () => {
    expect({ lightOnly: diff(deriveLight, deriveDark), darkOnly: diff(deriveDark, deriveLight) })
      .toEqual({ lightOnly: [], darkOnly: [] });
  });

  it("do not also sit on :root — one spelling per token", () => {
    expect([...deriveLight].filter((t) => deriveRoot.has(t))).toEqual([]);
  });
});

/**
 * Every `var(--x)` in the app must name a property something declares. The
 * declaring side is broad on purpose — any `--x:` in a stylesheet, a CSS-in-TS
 * template (`markdownThemes.ts`), or an inline style object — because a
 * component-local property (`--panel-width`, `--md-size`) is as legitimate as
 * a token. What it catches is a name nobody ever wrote.
 */
describe("no dangling custom-property reference", () => {
  const files = walk("src").filter((f) => /\.(css|ts|tsx)$/.test(f) && !f.includes("__tests__"));
  const declaredAnywhere = new Set<string>();
  const refs: { file: string; name: string }[] = [];
  for (const f of files) {
    const text = f.endsWith(".css") ? stripComments(read(f)) : read(f);
    for (const m of text.matchAll(/(--[\w-]+)\s*["']?\s*:/g)) declaredAnywhere.add(m[1]);
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
      // `var(--color-*)` in a prose comment is a family, not a reference.
      if (!m[1].endsWith("-")) refs.push({ file: f, name: m[1] });
    }
  }

  it("scanned the app", () => {
    expect(refs.length).toBeGreaterThan(500);
    expect(declaredAnywhere.has("--color-bg-base")).toBe(true);
  });

  it("finds every var(--x) declared somewhere", () => {
    const dangling = [...new Set(refs.filter((r) => !declaredAnywhere.has(r.name)).map((r) => `${r.name} ← ${r.file}`))].sort();
    expect(dangling).toEqual([]);
  });
});

/**
 * `data-theme`'s value is a cascade key, not a fact about the colours: once
 * theme files exist it is an arbitrary id. Everything that needs "light or
 * dark?" reads `data-scheme` through lib/theme/scheme.
 */
describe("nothing reads data-theme's value", () => {
  const files = walk("src").filter((f) => /\.(ts|tsx|css)$/.test(f) && !f.includes("__tests__"));
  it("outside lib/theme/scheme.ts and tokens.css", () => {
    const offenders = files.filter((f) => {
      if (f === "src/lib/theme/scheme.ts" || f === "src/styles/tokens.css") return false;
      const text = read(f);
      return /getAttribute\(\s*["']data-theme["']\s*\)/.test(text) || /data-theme=["'](light|dark)["']/.test(text);
    });
    expect(offenders).toEqual([]);
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
    const css = stripComments(read(path));
    const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? [];
    expect(literals).toEqual([]);
  });
});
