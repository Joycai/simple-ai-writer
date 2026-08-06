/**
 * Markdown typography themes — one look shared by every rendered-markdown
 * surface: the editor preview pane, the lore previews, and exported HTML/PDF.
 *
 * Why the CSS lives in TypeScript rather than a `.module.css`: exported HTML is
 * self-contained, so the same rules have to be serialised into a `<style>` tag
 * with no build step and no design tokens around them. Keeping one generator
 * means the file you print is the file you saw on screen; a stylesheet plus a
 * hand-maintained export copy would drift on the first theme tweak.
 *
 * Shape of a theme: a set of `--md-*` custom properties consumed by the shared
 * base rules, plus an optional `rules` string for its signature touches (the
 * magazine drop cap, the 公众号 heading bar). Colours stay in design tokens, so
 * every theme follows light/dark automatically; `EXPORT_TOKEN_CSS` re-declares
 * the light values for documents that leave the app.
 */

export type MarkdownThemeId = "manuscript" | "clean" | "magazine" | "wechat" | "typewriter";

export const MARKDOWN_THEME_IDS: MarkdownThemeId[] = [
  "manuscript",
  "clean",
  "magazine",
  "wechat",
  "typewriter",
];

export const DEFAULT_MARKDOWN_THEME: MarkdownThemeId = "manuscript";

/** Attribute on `<html>` that selects the active theme. */
export const MD_THEME_ATTR = "data-md-theme";

/** Class every rendered-markdown container carries. */
export const MD_BODY_CLASS = "md-body";

export interface MarkdownTheme {
  id: MarkdownThemeId;
  label: { zh: string; en: string };
  desc: { zh: string; en: string };
  /** `--md-*` overrides for this theme. */
  vars: Record<string, string>;
  /** Extra rules; every `&` is replaced by the container selector. */
  rules?: string;
}

export const MARKDOWN_THEMES: MarkdownTheme[] = [
  {
    id: "manuscript",
    label: { zh: "手稿", en: "Manuscript" },
    desc: { zh: "衬线体，居中标题，段首缩进两字 — 小说排版", en: "Serif, centred headings, indented paragraphs" },
    vars: {
      "--md-font-body": "var(--font-serif)",
      "--md-line": "1.78",
      "--md-para-indent": "2em",
      "--md-h1-align": "center",
      "--md-h2-align": "center",
      "--md-h1-size": "2.6em",
      "--md-h1-weight": "300",
      "--md-h2-size": "1.7em",
      "--md-h-weight": "400",
      "--md-quote-bg": "var(--color-bg-elevated)",
      "--md-hr-mark": '"— · —"',
      "--md-hr-line": "none",
      "--md-hr-height": "1em",
    },
  },
  {
    id: "clean",
    label: { zh: "素雅", en: "Clean" },
    desc: { zh: "无衬线，左对齐，行距宽松 — 报告、周报、文档", en: "Sans-serif, left-aligned, airy — reports and docs" },
    vars: {
      "--md-font-body": "var(--font-sans)",
      "--md-scale": "0.95",
      "--md-line": "1.85",
      "--md-h-weight": "600",
      "--md-h1-size": "1.9em",
      "--md-h1-weight": "600",
      "--md-h2-size": "1.42em",
      "--md-h3-size": "1.15em",
      "--md-h-space-top": "1.7em",
      "--md-quote-style": "normal",
      "--md-quote-bg": "var(--color-bg-elevated)",
      "--md-quote-border": "3px solid var(--md-color-border)",
    },
  },
  {
    id: "magazine",
    label: { zh: "杂志", en: "Magazine" },
    desc: { zh: "大字标题、章节横线、首字下沉 — 特稿与长文", en: "Display headings, rules, drop cap — long-form features" },
    vars: {
      "--md-font-body": "var(--font-serif)",
      "--md-scale": "1.06",
      "--md-line": "1.72",
      "--md-h1-size": "3em",
      "--md-h1-weight": "300",
      "--md-h1-letter": "-0.022em",
      "--md-h2-size": "1.5em",
      "--md-h-weight": "500",
      "--md-h-space-top": "1.8em",
      "--md-quote-style": "italic",
      "--md-quote-border": "none",
      "--md-hr-line": "none",
      "--md-hr-mark": '"◆"',
    },
    rules: `
& h2 { border-bottom: 1px solid var(--md-color-border); padding-bottom: 0.25em; }
& h3 { text-transform: uppercase; letter-spacing: 0.16em; font-size: 0.95em; color: var(--md-color-dim); }
& blockquote {
  font-size: 1.2em;
  line-height: 1.5;
  text-align: center;
  padding: 0.6em 1.4em;
  color: var(--md-color-text);
}
/* Drop cap on the opening paragraph only — mid-document it reads as noise.
   first-of-type, not first-child: a document usually opens with its title. */
& > p:first-of-type::first-letter {
  float: left;
  font-family: var(--md-font-heading);
  font-size: 3.1em;
  line-height: 0.86;
  font-weight: 300;
  padding: 0.04em 0.08em 0 0;
  color: var(--md-color-accent);
}`,
  },
  {
    id: "wechat",
    label: { zh: "公众号", en: "WeChat" },
    desc: { zh: "居中标题配色条，紧凑正文 — 贴近微信文章观感", en: "Centred headings with accent bars — WeChat article look" },
    vars: {
      "--md-font-body": "var(--font-sans)",
      "--md-scale": "0.95",
      "--md-line": "1.8",
      "--md-letter": "0.02em",
      "--md-para-gap": "1.25em",
      "--md-h1-align": "center",
      "--md-h2-align": "center",
      "--md-h1-size": "1.75em",
      "--md-h1-weight": "600",
      "--md-h2-size": "1.3em",
      "--md-h3-size": "1.1em",
      "--md-h-weight": "600",
      "--md-quote-style": "normal",
      "--md-quote-bg": "var(--color-accent-tint)",
      "--md-quote-border": "3px solid var(--md-color-accent)",
      "--md-hr-line": "1px dashed var(--md-color-border)",
    },
    rules: `
& h2::after {
  content: "";
  display: block;
  width: 42px;
  height: 3px;
  margin: 0.45em auto 0;
  background: var(--md-color-accent);
}
& h3 { color: var(--md-color-accent); }
& blockquote { font-size: 0.96em; }
& img { margin-left: auto; margin-right: auto; }`,
  },
  {
    id: "typewriter",
    label: { zh: "打字机", en: "Typewriter" },
    desc: { zh: "等宽字体，保留 # 标记 — 接近源码的朴素观感", en: "Monospace with visible # markers — close to the source" },
    vars: {
      "--md-font-body": "var(--font-mono)",
      "--md-scale": "0.9",
      "--md-line": "1.9",
      "--md-h1-size": "1.7em",
      "--md-h1-weight": "700",
      "--md-h2-size": "1.35em",
      "--md-h3-size": "1.12em",
      "--md-h-weight": "700",
      "--md-h-space-top": "1.9em",
      "--md-quote-style": "normal",
      "--md-quote-border": "1px dashed var(--md-color-accent)",
      "--md-hr-line": "1px dashed var(--md-color-border)",
    },
    rules: `
& h1::before, & h2::before, & h3::before, & h4::before {
  color: var(--md-color-faint);
  font-weight: 400;
}
& h1::before { content: "# "; }
& h2::before { content: "## "; }
& h3::before { content: "### "; }
& h4::before { content: "#### "; }
& code { background: var(--md-color-surface); }`,
  },
];

export function findMarkdownTheme(id: string | null | undefined): MarkdownTheme {
  return MARKDOWN_THEMES.find((t) => t.id === id) ?? MARKDOWN_THEMES[0];
}

/**
 * The theme currently applied to the app. Read off the DOM rather than the
 * store so lib-layer callers (export) don't have to reach into React state.
 */
export function currentMarkdownThemeId(): MarkdownThemeId {
  const raw = document.documentElement.getAttribute(MD_THEME_ATTR);
  return findMarkdownTheme(raw).id;
}

// ─── CSS generation ───────────────────────────────────────────────────────────

/** Element rules, written entirely against `--md-*` so themes only set vars. */
function baseCss(s: string): string {
  return `
/* Defaults live in :where() — zero specificity — so a surface can set its own
   --md-size (the preview pane is roomier than a modal field) from a plain class
   without losing to this block, which is injected after the app's stylesheets.
   A theme only nudges the size with --md-scale, so picking one never resizes a
   container that was deliberately scaled down. */
:where(${s}) {
  --md-font-body: var(--font-serif);
  --md-font-heading: var(--md-font-body);
  --md-font-mono: var(--font-mono);
  --md-size: 16px;
  --md-scale: 1;
  --md-line: 1.78;
  --md-letter: normal;
  --md-para-gap: 1.1em;
  --md-para-indent: 0;
  --md-h-weight: 500;
  --md-h-space-top: 1.5em;
  --md-h-space-bottom: 0.5em;
  --md-h1-size: 2.2em;
  --md-h1-weight: var(--md-h-weight);
  --md-h1-letter: -0.01em;
  --md-h1-align: left;
  --md-h2-size: 1.55em;
  --md-h2-align: left;
  --md-h3-size: 1.2em;
  --md-h4-size: 1.05em;
  --md-list-indent: 1.8em;
  --md-quote-style: italic;
  --md-quote-border: 2px solid var(--md-color-accent);
  --md-quote-bg: transparent;
  --md-hr-line: 1px solid var(--md-color-border);
  --md-hr-mark: "";
  --md-hr-height: auto;
  --md-color-text: var(--color-text-primary);
  --md-color-dim: var(--color-text-secondary);
  --md-color-faint: var(--color-text-ghost);
  --md-color-accent: var(--color-sienna);
  --md-color-surface: var(--color-bg-elevated);
  --md-color-border: var(--color-border-soft);
}

${s} {
  font-family: var(--md-font-body);
  font-size: calc(var(--md-size) * var(--md-scale));
  line-height: var(--md-line);
  letter-spacing: var(--md-letter);
  color: var(--md-color-text);
  word-break: break-word;
  /* The app body is pre-wrap (raw text surfaces); rendered markdown is not. */
  white-space: normal;
}
${s} > :first-child { margin-top: 0; }
${s} > :last-child { margin-bottom: 0; }

${s} h1, ${s} h2, ${s} h3, ${s} h4, ${s} h5, ${s} h6 {
  font-family: var(--md-font-heading);
  font-weight: var(--md-h-weight);
  color: var(--md-color-text);
  line-height: 1.28;
  margin: var(--md-h-space-top) 0 var(--md-h-space-bottom);
}
${s} h1 {
  font-size: var(--md-h1-size);
  font-weight: var(--md-h1-weight);
  letter-spacing: var(--md-h1-letter);
  text-align: var(--md-h1-align);
  margin-top: 0.4em;
  margin-bottom: 0.7em;
}
${s} h2 { font-size: var(--md-h2-size); text-align: var(--md-h2-align); }
${s} h3 { font-size: var(--md-h3-size); }
${s} h4 { font-size: var(--md-h4-size); }
${s} h5, ${s} h6 { font-size: 1em; color: var(--md-color-dim); }

${s} p {
  margin: 0 0 var(--md-para-gap);
  text-indent: var(--md-para-indent);
}

${s} ul, ${s} ol { margin: 0 0 var(--md-para-gap); padding-left: var(--md-list-indent); }
${s} li { margin: 0.25em 0; }
${s} li p, ${s} blockquote p, ${s} td p, ${s} th p { text-indent: 0; }
${s} li > p { margin: 0.25em 0; }

${s} blockquote {
  margin: 0 0 var(--md-para-gap);
  padding: 0.5em 1em;
  border-left: var(--md-quote-border);
  background: var(--md-quote-bg);
  color: var(--md-color-dim);
  font-style: var(--md-quote-style);
}

${s} code {
  font-family: var(--md-font-mono);
  font-size: 0.9em;
  font-style: normal;
  background: var(--md-color-surface);
  color: var(--md-color-accent);
  padding: 1px 5px;
}
${s} pre {
  font-family: var(--md-font-mono);
  font-size: 0.85em;
  line-height: 1.6;
  background: var(--md-color-surface);
  border: 1px solid var(--md-color-border);
  padding: 0.9em 1.1em;
  margin: 0 0 var(--md-para-gap);
  overflow-x: auto;
}
${s} pre code {
  background: none;
  border: none;
  padding: 0;
  color: var(--md-color-text);
  font-size: inherit;
}

${s} a {
  color: var(--md-color-accent);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

${s} strong { font-weight: 700; color: var(--md-color-text); }
${s} em { font-style: italic; }
${s} del { color: var(--md-color-faint); }

${s} hr {
  border: none;
  border-top: var(--md-hr-line);
  height: var(--md-hr-height);
  margin: 2em 0;
  text-align: center;
  overflow: visible;
}
${s} hr::before {
  content: var(--md-hr-mark);
  font-family: var(--md-font-heading);
  font-size: 0.9em;
  letter-spacing: 0.5em;
  color: var(--md-color-faint);
}

${s} img { max-width: 100%; height: auto; display: block; margin: 1em 0; }
${s} img[data-broken] { min-height: 24px; border: 1px dashed var(--md-color-border); }

${s} table {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 var(--md-para-gap);
  font-size: 0.85em;
  font-family: var(--md-font-body);
}
${s} th, ${s} td { border: 1px solid var(--md-color-border); padding: 6px 10px; text-align: left; }
${s} th { background: var(--md-color-surface); font-weight: 600; }

${s} .katex-display { overflow-x: auto; text-indent: 0; }
${s} .mermaid { text-align: center; margin: 1em 0; }
`.trim();
}

function varsBlock(scope: string, vars: Record<string, string>): string {
  const body = Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join("\n");
  return `${scope} {\n${body}\n}`;
}

function themeBlock(theme: MarkdownTheme, scope: string): string {
  const rules = theme.rules ? theme.rules.replace(/&/g, scope).trim() : "";
  return [varsBlock(scope, theme.vars), rules].filter(Boolean).join("\n");
}

/**
 * Full stylesheet for one theme under an arbitrary container selector — used by
 * export, where the container is `<body>` and no theme attribute exists.
 */
export function markdownThemeCss(id: MarkdownThemeId, scope: string): string {
  return `${baseCss(scope)}\n\n${themeBlock(findMarkdownTheme(id), scope)}`;
}

/**
 * Every theme at once. Normally the `data-md-theme` attribute sits on `<html>`
 * and applies to every `.md-body` below it; a container may also carry the
 * attribute itself to pin one theme regardless of the app setting (the settings
 * picker's samples do this). Both selectors have the same specificity, so the
 * self-scoped pass is emitted last — later wins, and a pinned container is
 * never overridden by whichever theme happens to come later in the list.
 */
export function markdownThemesCss(): string {
  const base = baseCss(`.${MD_BODY_CLASS}`);
  const inherited = MARKDOWN_THEMES
    .map((t) => themeBlock(t, `[${MD_THEME_ATTR}="${t.id}"] .${MD_BODY_CLASS}`))
    .join("\n\n");
  const pinned = MARKDOWN_THEMES
    .map((t) => themeBlock(t, `.${MD_BODY_CLASS}[${MD_THEME_ATTR}="${t.id}"]`))
    .join("\n\n");
  return `${base}\n\n${inherited}\n\n${pinned}`;
}

/**
 * Light-mode design tokens for documents that leave the app. Exported HTML has
 * no `tokens.css`, so the themes' `var(--color-*)` references are declared here
 * instead — same CSS text, self-supplied palette. Bundled webfonts don't travel
 * with the file; every stack falls back to system faces.
 */
export const EXPORT_TOKEN_CSS = `:root {
  --font-serif: "Spectral", Georgia, "Songti SC", "Noto Serif CJK SC", serif;
  --font-sans: "Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace;
  --color-text-primary: #2A2520;
  --color-text-secondary: #5C5346;
  --color-text-muted: #8B7E6A;
  --color-text-ghost: #C0B49E;
  --color-sienna: #A0522D;
  --color-bg-base: #F7F2E8;
  --color-bg-surface: #FBF8F0;
  --color-bg-elevated: #F1E8D5;
  --color-border: #E5DCC9;
  --color-border-soft: #ECE2CE;
  --color-accent-tint: rgba(160, 82, 45, 0.10);
}`;

let installed: HTMLStyleElement | null = null;

/** Injects the theme stylesheet once, at startup. */
export function installMarkdownThemeStyles(): void {
  if (installed) return;
  installed = document.createElement("style");
  installed.id = "md-themes";
  installed.textContent = markdownThemesCss();
  document.head.appendChild(installed);
}
