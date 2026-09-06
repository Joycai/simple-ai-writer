/**
 * The token contract, read out of `tokens.css` itself.
 *
 * A theme file is validated against the list of tokens the app actually
 * declares — a name it does not know is dropped with a reason, a scale token
 * is refused because layout is not a theme's to change — and the export
 * palette is generated from the built-in bases' values. Both need the same
 * three facts about `tokens.css` (docs/feature/theme-system-plan.md §4, §12):
 * which names are scale, which are core, and which are derived, plus the
 * values the built-in themes give them.
 *
 * This module is the one parser of that file. `themeContract.test.ts` runs it
 * over the source and pins the invariants; `contractData.ts` is the same parse
 * frozen into a constant for the runtime (vitest stubs every `.css` import,
 * `?raw` included, so a module the stores depend on cannot import the file —
 * see `scripts/gen-theme-contract.ts`, and the test that fails the moment the
 * constant and the file disagree).
 *
 * The parser is textual on purpose: it runs in node, and the file is ours —
 * five `@layer` blocks, flat `:root` / `[data-*]` rules, one declaration per
 * line. It is not a CSS parser and must not be asked to be one.
 */

export type ColorSchemeName = "light" | "dark";

export interface TokenContract {
  /** L0 — theme-independent scales (`tokens.scale`). A theme may not touch these. */
  scale: string[];
  /** L1 — the core contract (`tokens.scheme`): what a theme is expected to write. */
  core: string[];
  /** L2 — every other token (`tokens.derive` ∪ `tokens.theme`), with a default. */
  derived: string[];
  /** The two built-in bases' core values, by polarity. */
  coreValues: Record<ColorSchemeName, Record<string, string>>;
  /** Derive-layer defaults: on `:root`, or per scheme when the direction flips. */
  deriveDefaults: { root: Record<string, string> } & Record<ColorSchemeName, Record<string, string>>;
  /** The built-in themes' hand-tuned derived values (`tokens.theme`), by theme id. */
  handTuned: Record<string, Record<string, string>>;
  /** The `[data-font="…"]` blocks — each font scheme's `--font-*` stacks. */
  fontSchemes: Record<string, Record<string, string>>;
}

export interface CssBlock {
  /** The preludes enclosing this block, outermost first — enough to tell a layer apart. */
  path: string[];
  body: string;
}

export const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every rule block in `css` with the preludes enclosing it. Comments are
 * stripped first; a stray `{` inside a string would confuse it, and none is
 * expected in a token file.
 */
export function cssBlocks(css: string): CssBlock[] {
  const s = stripCssComments(css);
  const out: CssBlock[] = [];
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
  if (stack.length) throw new Error("unbalanced braces in tokens.css");
  return out;
}

/** `--name: value;` pairs declared directly in `body` (nested blocks removed). */
export function declaredValues(body: string): Record<string, string> {
  const direct = body.replace(/[^{};]*\{[^{}]*\}/g, "");
  const out: Record<string, string> = {};
  for (const m of direct.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** Custom-property names declared directly in `body`. */
export function declaredNames(body: string): Set<string> {
  return new Set(Object.keys(declaredValues(body)));
}

const inLayer = (all: CssBlock[], name: string) => all.filter((b) => b.path[0] === `@layer ${name}`);
const named = (bs: CssBlock[], selector: string) =>
  bs.filter((b) => b.path[b.path.length - 1] === selector && !b.path.some((p) => p.startsWith("@supports")));
const merged = (bs: CssBlock[]): Record<string, string> =>
  Object.assign({}, ...bs.map((b) => declaredValues(b.body)));

export function parseTokenContract(css: string): TokenContract {
  const all = cssBlocks(css);
  const scale = merged(named(inLayer(all, "tokens.scale"), ":root"));
  const coreLight = merged(named(inLayer(all, "tokens.scheme"), '[data-scheme="light"]'));
  const coreDark = merged(named(inLayer(all, "tokens.scheme"), '[data-scheme="dark"]'));
  const deriveRoot = merged(named(inLayer(all, "tokens.derive"), ":root"));
  const deriveLight = merged(named(inLayer(all, "tokens.derive"), '[data-scheme="light"]'));
  const deriveDark = merged(named(inLayer(all, "tokens.derive"), '[data-scheme="dark"]'));
  const handTuned: Record<string, Record<string, string>> = {};
  for (const b of inLayer(all, "tokens.theme")) {
    const m = /^\[data-theme="([^"]+)"\]$/.exec(b.path[b.path.length - 1] ?? "");
    if (!m) continue;
    handTuned[m[1]] = { ...(handTuned[m[1]] ?? {}), ...declaredValues(b.body) };
  }
  const fontSchemes: Record<string, Record<string, string>> = {};
  for (const b of inLayer(all, "tokens.scale")) {
    const m = /^\[data-font="([^"]+)"\]$/.exec(b.path[b.path.length - 1] ?? "");
    if (m) fontSchemes[m[1]] = { ...(fontSchemes[m[1]] ?? {}), ...declaredValues(b.body) };
  }
  const derived = new Set<string>([
    ...Object.keys(deriveRoot),
    ...Object.keys(deriveLight),
    ...Object.keys(deriveDark),
    ...Object.values(handTuned).flatMap((t) => Object.keys(t)),
  ]);
  return {
    scale: Object.keys(scale).sort(),
    core: Object.keys(coreLight).sort(),
    derived: [...derived].sort(),
    coreValues: { light: coreLight, dark: coreDark },
    deriveDefaults: { root: deriveRoot, light: deriveLight, dark: deriveDark },
    handTuned,
    fontSchemes,
  };
}

/** Which tier a name belongs to under `contract`; `null` = the app has no such token. */
export function tokenTier(contract: Pick<TokenContract, "scale" | "core" | "derived">, name: string):
  "scale" | "core" | "derived" | null {
  if (contract.core.includes(name)) return "core";
  if (contract.derived.includes(name)) return "derived";
  if (contract.scale.includes(name)) return "scale";
  return null;
}
