/**
 * The palette a document takes with it when it leaves the app.
 *
 * Exported HTML has no `tokens.css`, so the markdown theme's `var(--color-*)`
 * references need declaring inside the file. This used to be a hand-copied
 * light palette in `markdownThemes.ts` — the one token copy in the app that
 * could drift, and did. It is generated now (docs/feature/theme-system-plan.md
 * §9): the current light theme's core on `:root`, the current dark theme's
 * under `prefers-color-scheme: dark`, and `color-scheme: light dark` so the
 * reader's browser paints its own chrome to match. The author's user theme
 * therefore reaches the exported file, and a recipient on a dark system sees
 * the author's dark palette rather than a white page.
 *
 * Derived tokens are emitted only when the markdown CSS references them
 * (today: `--color-accent-tint` behind the 公众号 quote), with the value the
 * theme would resolve — the built-in's hand-tune, else the derive formula.
 * PDF goes through print, where `prefers-color-scheme` is light: paper.
 */
import type { TokenContract } from "./contract";
import type { ThemeEntry } from "./registry";
import type { ColorScheme } from "./scheme";

/**
 * Font stacks for a file read on a machine without the app's bundled faces:
 * every stack ends in system fallbacks. Kept apart from `tokens.css`'s own,
 * which name the bundled fonts first.
 */
export const EXPORT_FONT_CSS = `  --font-serif: "Spectral", Georgia, "Songti SC", "Noto Serif CJK SC", serif;
  --font-sans: "Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace;`;

/** Custom-property names `css` references through `var()`. */
export function referencedTokens(css: string): Set<string> {
  return new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
}

/**
 * The value `entry` gives `name` under `scheme`: the file's own token, the
 * built-in hand-tune, a scheme-keyed derive default, a root derive default,
 * or the base's core value.
 */
export function resolveTokenValue(
  entry: ThemeEntry,
  scheme: ColorScheme,
  name: string,
  contract: TokenContract,
): string | undefined {
  const own = entry.tokens?.[name];
  if (own !== undefined) return own;
  if (entry.source === "builtin") {
    const tuned = contract.handTuned[entry.id]?.[name];
    if (tuned !== undefined) return tuned;
  }
  return (
    contract.coreValues[scheme][name]
    ?? contract.deriveDefaults[scheme][name]
    ?? contract.deriveDefaults.root[name]
  );
}

/**
 * Every token the exported CSS needs: the whole core, plus the derived tokens
 * `css` references — and, transitively, whatever their formulas reference.
 */
function tokensToEmit(css: string, contract: TokenContract, entry: ThemeEntry, scheme: ColorScheme): string[] {
  const out = new Set<string>(contract.core);
  const queue = [...referencedTokens(css)].filter((n) => contract.derived.includes(n));
  while (queue.length) {
    const name = queue.shift() as string;
    if (out.has(name)) continue;
    out.add(name);
    const value = resolveTokenValue(entry, scheme, name, contract) ?? "";
    for (const ref of referencedTokens(value)) {
      if (contract.derived.includes(ref) && !out.has(ref)) queue.push(ref);
    }
  }
  return [...out];
}

function paletteBlock(entry: ThemeEntry, scheme: ColorScheme, names: string[], contract: TokenContract): string {
  return names
    .map((n) => {
      const v = resolveTokenValue(entry, scheme, n, contract);
      return v === undefined ? null : `  ${n}: ${v};`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * The `<style>` prelude for an exported document, ahead of the markdown
 * theme's own CSS (`mdCss`, which decides which derived tokens are needed).
 *
 * `only` pins one polarity with no media block — the settings samples are
 * drawn under the *app's* current scheme, and a sandboxed frame would
 * otherwise follow the OS's `prefers-color-scheme` instead.
 */
export function exportPaletteCss(
  light: ThemeEntry,
  dark: ThemeEntry,
  mdCss: string,
  contract: TokenContract,
  only?: ColorScheme,
): string {
  if (only) {
    const entry = only === "light" ? light : dark;
    return `:root {
  color-scheme: ${only};
${EXPORT_FONT_CSS}
${paletteBlock(entry, only, tokensToEmit(mdCss, contract, entry, only), contract)}
}`;
  }
  const lightNames = tokensToEmit(mdCss, contract, light, "light");
  const darkNames = tokensToEmit(mdCss, contract, dark, "dark");
  return `:root {
  color-scheme: light dark;
${EXPORT_FONT_CSS}
${paletteBlock(light, "light", lightNames, contract)}
}
@media (prefers-color-scheme: dark) {
  :root {
${paletteBlock(dark, "dark", darkNames, contract).replace(/^/gm, "  ")}
  }
}`;
}
