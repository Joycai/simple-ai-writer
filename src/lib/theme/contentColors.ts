/** Independent document palettes. No generated rule can target app chrome. */
import { MORANDI_CONTENT_COLORS } from "./contentColorData";
import { TOKEN_CONTRACT } from "./contractData";
import type { ThemeEntry } from "./registry";
import type { ColorScheme } from "./scheme";

export type ContentMode = "follow" | "auto" | "light" | "dark";
export const CONTENT_TOKENS = [
  "--md-color-bg",
  "--md-color-text",
  "--md-color-dim",
  "--md-color-faint",
  "--md-color-accent",
  "--md-color-surface",
  "--md-color-border",
  "--md-color-link",
  "--md-color-link-hover",
  "--md-color-h1",
  "--md-color-h2",
  "--md-color-h3",
  "--md-color-h4",
  "--md-color-h5",
  "--md-color-h6",
  "--md-color-quote-bg",
  "--md-color-quote-1",
  "--md-color-quote-2",
  "--md-color-quote-3",
  "--md-color-code-text",
  "--md-color-table-head",
  "--md-color-table-alt",
  "--md-color-selection"
];
export const CONTENT_IDS = ["morandi-content-light", "morandi-content-dark"];
// Frozen example palettes (checked against themes/*.css in tests).
export const BUILTIN_CONTENT_THEMES: ThemeEntry[] = MORANDI_CONTENT_COLORS.map((tokens, i) => ({
  id: CONTENT_IDS[i], kind: "markdown-color", scheme: i ? "dark" : "light",
  name: { zh: i ? "莫兰迪内容 · 暮色" : "莫兰迪内容 · 豆绿", en: i ? "Morandi content · Dusk" : "Morandi content · Sage" },
  extends: i ? "content-dark" : "content-light", source: "builtin", usable: true, problems: [], kept: CONTENT_TOKENS.length,
  tokens,
}));

export function resolveContentTheme(entries: ThemeEntry[], id: string, scheme: ColorScheme): ThemeEntry {
  return entries.find((e) => e.id === id && e.usable && e.scheme === scheme)
    ?? { id: `content-${scheme}`, kind: "markdown-color", scheme, name: scheme, extends: `content-${scheme}`, source: "builtin", usable: true, kept: 0, problems: [] };
}

/** Rebind legacy references only in typography CSS; never redefine UI variables. */
export function contentCompatibleCss(css: string): string {
  const pattern = /var\(\s*(--color-[\w-]+)/g;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css))) {
    let depth = 1;
    let end = pattern.lastIndex;
    while (end < css.length && depth) {
      if (css[end] === "(") depth++;
      if (css[end] === ")") depth--;
      end++;
    }
    if (depth) break;
    const original = css.slice(match.index, end);
    out += css.slice(cursor, match.index) + `var(--md-legacy${match[1].slice(1)}, ${original})`;
    cursor = end;
    pattern.lastIndex = end;
  }
  return out + css.slice(cursor);
}

export function contentPaletteCss(entry: ThemeEntry, scope = "html[data-md-theme] .md-body"): string {
  const surfaceScope = scope.replace(".md-body", "[data-md-surface]");
  scope = scope.replace(".md-body", ":is(.md-body, [data-md-content])");
  const scheme = entry.scheme ?? "light";
  const core = TOKEN_CONTRACT.coreValues[scheme];
  const defaults: Record<string, string> = {
    bg: core["--color-bg-base"], text: core["--color-text-primary"], dim: core["--color-text-secondary"],
    faint: core["--color-text-muted"], accent: core["--color-sienna"], surface: core["--color-bg-elevated"],
    border: core["--color-border"], link: core["--color-sienna"], "link-hover": core["--color-sienna-hover"],
    h1: core["--color-amber"], h2: core["--color-sienna"], h3: core["--color-type-image-fg"],
    h4: core["--color-type-video-fg"], h5: core["--color-amber"], h6: core["--color-text-secondary"],
    "quote-bg": core["--color-bg-elevated"], "quote-1": core["--color-amber"], "quote-2": core["--color-type-image-fg"], "quote-3": core["--color-type-video-fg"],
    "code-text": core["--color-type-image-fg"], "table-head": core["--color-bg-elevated"], "table-alt": core["--color-bg-tinted"], selection: core["--color-bg-hover"],
  };
  const colors = { ...Object.fromEntries(Object.entries(defaults).map(([k,v]) => [`--md-color-${k}`,v])), ...entry.tokens };
  const alias: Record<string,string> = {
    "bg-base":"bg", "bg-surface":"bg", "bg-elevated":"surface", "bg-tinted":"surface", "bg-hover":"table-head",
    "text-primary":"text", "text-secondary":"dim", "text-muted":"faint", "text-faint":"faint", "text-ghost":"faint",
    sienna:"accent", "sienna-hover":"link-hover", amber:"h1", "amber-soft":"quote-bg",
    border:"border", "border-soft":"border", "border-strong":"border", "type-image-fg":"h3", "type-video-fg":"h4", "type-asr-fg":"link",
  };
  const legacy = { ...core, ...TOKEN_CONTRACT.deriveDefaults.root, ...TOKEN_CONTRACT.deriveDefaults[scheme] };
  for (const [key,value] of Object.entries(alias)) legacy[`--color-${key}`] = colors[`--md-color-${value}`];
  const declarations = Object.entries(colors).map(([k,v]) => `${k}: ${v};`).join("\n");
  const compat = Object.entries(legacy).filter(([k])=>k.startsWith("--color-")).map(([k,v]) =>
    `--md-legacy${k.slice(1)}: ${v.replace(/var\(\s*(--color-[\w-]+)/g, (_, ref: string) => `var(--md-legacy${ref.slice(1)}`)};`).join("\n");
  return `${surfaceScope} { background-color: ${colors["--md-color-bg"]}; color-scheme: ${scheme}; scrollbar-color: ${colors["--md-color-border"]} ${colors["--md-color-bg"]}; }
  ${scope}[data-md-content] { padding: 12px; border-radius: 6px; }
  ${scope} {
${declarations}
${compat}
    color-scheme: ${scheme}; color: var(--md-color-text); background-color: var(--md-color-bg);
    --md-quote-bg: var(--md-color-quote-bg);
  }
  ${[1,2,3,4,5,6].map((n)=>`${scope} h${n} { color: var(--md-color-h${n}); }`).join("\n")}
  ${scope} a { color: var(--md-color-link); }
  ${scope} a:hover { color: var(--md-color-link-hover); }
  ${scope} blockquote { background-color: var(--md-color-quote-bg); border-left-color: var(--md-color-quote-1); }
  ${scope} blockquote blockquote { border-left-color: var(--md-color-quote-2); }
  ${scope} blockquote blockquote blockquote { border-left-color: var(--md-color-quote-3); }
  ${scope} code { color: var(--md-color-code-text); background-color: var(--md-color-surface); }
  ${scope} pre, ${scope} pre code { color: var(--md-color-text); background-color: var(--md-color-surface); }
  ${scope} th { background-color: var(--md-color-table-head); }
  ${scope} tbody tr:nth-child(even) { background-color: var(--md-color-table-alt); }
  ${scope}::selection, ${scope} ::selection { background: var(--md-color-selection); color: var(--md-color-text); }`;
}
