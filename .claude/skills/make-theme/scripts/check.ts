/**
 * The TypeScript half of check-theme.mjs — loaded through vite so it can import
 * the app's own theme modules. Everything that decides "would the app accept
 * this rule" is the runtime's predicate, not a re-implementation: the app
 * validates over the browser's CSSOM, node has none, so (like
 * themeExamples.test.ts) this walks the text with the contract's brace
 * tokenizer and hands each selector / url / token name to the same functions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { cssBlocks, stripCssComments, tokenTier } from "../../../../src/lib/theme/contract";
import { TOKEN_CONTRACT } from "../../../../src/lib/theme/contractData";
import { exportPaletteCss, referencedTokens } from "../../../../src/lib/theme/export";
import {
  BUILTIN_MARKDOWN_IDS, BUILTIN_UI_IDS, readThemeMeta, themeIdFromFileName,
} from "../../../../src/lib/theme/manifest";
import { markdownThemeCss, type MarkdownThemeId } from "../../../../src/lib/theme/markdownThemes";
import { BUILTIN_UI_THEMES, type ThemeEntry } from "../../../../src/lib/theme/registry";
import { BUILTIN_THEME_FOR_SCHEME, type ColorScheme } from "../../../../src/lib/theme/scheme";
import { isAllowedUrl, isMdSelector, isThemeSelector, splitSelectors, urlsIn } from "../../../../src/lib/theme/validate";

// ── reading a file ───────────────────────────────────────────────────────────

/** `name: value` pairs written directly in `body` (nested blocks removed). */
function decls(body: string): [string, string][] {
  const direct = body.replace(/[^{};]*\{[^{}]*\}/g, "");
  return direct
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d): [string, string] => {
      const i = d.indexOf(":");
      return i > 0 ? [d.slice(0, i).trim(), d.slice(i + 1).trim()] : [d, ""];
    });
}

const CONDITIONAL = /^@(media|supports|container)\b/;

interface Parsed {
  path: string;
  file: string;
  id: string | null;
  css: string;
  meta: Record<string, string>;
  kind: "ui" | "markdown";
}

function parse(path: string): Parsed {
  const css = readFileSync(path, "utf-8");
  const meta: Record<string, string> = {};
  for (const b of cssBlocks(css)) {
    if (b.path.some((p) => p.startsWith("@") && !CONDITIONAL.test(p))) continue;
    for (const [n, v] of decls(b.body)) if (n.startsWith("--theme-")) meta[n] = v;
  }
  const file = basename(path);
  return { path, file, id: themeIdFromFileName(file), css, meta, kind: meta["--theme-kind"] === "markdown" ? "markdown" : "ui" };
}

// ── contrast ─────────────────────────────────────────────────────────────────

const HEX = /^#[0-9a-f]{6}$/i;
function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number | null {
  if (!HEX.test(a) || !HEX.test(b)) return null;
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ── the two checks ───────────────────────────────────────────────────────────

interface Report {
  errors: string[];
  warnings: string[];
  info: string[];
  tokens: Record<string, string>;
}

function checkCommon(t: Parsed, r: Report): void {
  if (!t.id) r.errors.push(`file name "${t.file}" is not an installable id — lowercase letters, digits, hyphens, ending in .css`);
  const reserved = t.kind === "ui" ? BUILTIN_UI_IDS : BUILTIN_MARKDOWN_IDS;
  if (t.id && reserved.includes(t.id)) r.errors.push(`"${t.id}" is a built-in id and cannot install — rename the file`);
  if (!t.meta["--theme-kind"]) r.errors.push("--theme-kind is missing (ui | markdown) — without it the file is read as an appearance theme");
  // Statement at-rules have no block, so the brace walk never meets them.
  for (const m of stripCssComments(t.css).matchAll(/(?:^|[;}])\s*(@[\w-]+)[^{};]*;/g)) {
    r.errors.push(`at-rule not allowed: ${m[1]} — the app drops it (fonts come in through @font-face with a relative url)`);
  }
  const reading = readThemeMeta(t.meta);
  for (const p of reading.problems) r.errors.push(`metadata: ${p.reason} ${JSON.stringify(p.params ?? {})}`);
}

function checkUi(t: Parsed, r: Report): void {
  for (const b of cssBlocks(t.css)) {
    const head = b.path[b.path.length - 1];
    if (b.path.some((p) => p.startsWith("@"))) {
      r.errors.push(`at-rule not allowed in an appearance theme: ${b.path.find((p) => p.startsWith("@"))}`);
      continue;
    }
    if (!isThemeSelector(head, t.id ?? "")) {
      r.errors.push(`selector outside the contract: "${head}" — an appearance theme is :root { tokens } and nothing else`);
      continue;
    }
    for (const [name, value] of decls(b.body)) {
      if (name.startsWith("--theme-")) continue;
      if (!name.startsWith("--")) { r.errors.push(`plain property "${name}" — only tokens`); continue; }
      const tier = tokenTier(TOKEN_CONTRACT, name);
      if (tier === "core" || tier === "derived") r.tokens[name] = value;
      else r.errors.push(`${name}: ${tier === "scale" ? "a scale token (layout / type size) — not a theme's to set" : "not a token the app declares"}`);
    }
  }
  const scheme = t.meta["--theme-scheme"] as ColorScheme | undefined;
  if (scheme && t.meta["--theme-extends"] !== BUILTIN_THEME_FOR_SCHEME[scheme]) {
    r.warnings.push(`--theme-extends should say "${BUILTIN_THEME_FOR_SCHEME[scheme]}" for a ${scheme} theme (shipped samples must)`);
  }
  const missing = TOKEN_CONTRACT.core.filter((c) => !(c in r.tokens));
  if (missing.length) {
    r.warnings.push(`${missing.length} core token(s) not written — they silently inherit the base's hues, which over a different ground reads as a bug (an error for a file shipped in themes/): ${missing.join(" ")}`);
  }
  const g = r.tokens["--color-bg-base"] ?? "";
  const pairs: [string, string, string, number, boolean][] = [
    ["accent on base", "--color-sienna", g, 4.5, true],
    ["accent on surface", "--color-sienna", r.tokens["--color-bg-surface"] ?? "", 4.5, false],
    ["text-primary on base", "--color-text-primary", g, 7, true],
    ["text-secondary on base", "--color-text-secondary", g, 4.5, false],
    ["text-muted on base", "--color-text-muted", g, 3, false],
    ["surface on accent (button label)", "--color-bg-surface", r.tokens["--color-sienna"] ?? "", 4.5, false],
    ...["text", "multimodal", "image", "video", "vision", "asr"].map(
      (k): [string, string, string, number, boolean] =>
        [`type-${k} fg on its bg`, `--color-type-${k}-fg`, r.tokens[`--color-type-${k}-bg`] ?? "", 4.5, false],
    ),
  ];
  for (const [label, tok, over, want, hard] of pairs) {
    const c = contrast(r.tokens[tok] ?? "", over);
    if (c === null) continue; // rgba washes cannot be measured without compositing
    const line = `${label}: ${c.toFixed(2)}:1 (want ≥ ${want})`;
    if (c >= want) r.info.push(line);
    else (hard ? r.errors : r.warnings).push(line);
  }
  // The ramp's order is what makes hover and elevation read at all.
  const L = (k: string) => (HEX.test(r.tokens[k] ?? "") ? luminance(r.tokens[k]) : null);
  const [base, elev, hover] = [L("--color-bg-base"), L("--color-bg-elevated"), L("--color-bg-hover")];
  if (base !== null && elev !== null && hover !== null) {
    const ok = scheme === "dark" ? base < elev && elev < hover : base > elev && elev > hover;
    if (!ok) r.warnings.push(`grounds out of order — ${scheme === "dark" ? "dark: base < elevated < hover (each step lighter)" : "light: base > elevated > hover (each step darker)"}`);
  }
}

/**
 * WebKit (the app's engine on macOS) cannot serialise a shorthand that holds a
 * var() once a longhand of the same family follows it in the block: cssText
 * comes back as `background-image: ; background-color: ; …` and the validator,
 * which re-emits rules from cssText, installs the rule without it. Chrome
 * serialises it fine, so the preview here will not show the loss.
 */
const NOT_LONGHANDS = /^border-(radius|collapse|spacing)$/;
function lostShorthands(ds: [string, string][]): string[] {
  const out: string[] = [];
  ds.forEach(([name, value], i) => {
    if (name.startsWith("--") || !/var\(/.test(value)) return;
    const later = ds.slice(i + 1).find(([n]) => n.startsWith(`${name}-`) && !NOT_LONGHANDS.test(n));
    if (later) out.push(`${name} (var) + ${later[0]}`);
  });
  return out;
}

const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/i;

function checkMarkdown(t: Parsed, r: Report): void {
  const own = new Set<string>();
  const literal: string[] = [];
  for (const b of cssBlocks(t.css)) {
    const head = b.path[b.path.length - 1];
    const outer = b.path.slice(0, -1);
    if (outer.some((p) => /^@keyframes\b/.test(p))) continue; // from / to / 50%
    const badOuter = outer.find((p) => !CONDITIONAL.test(p));
    if (badOuter) { r.errors.push(`nested under "${badOuter}" — only @media / @supports / @container may wrap rules`); continue; }
    if (head.startsWith("@")) {
      if (CONDITIONAL.test(head) || /^@keyframes\b/.test(head)) continue;
      if (/^@font-face\b/.test(head)) {
        for (const [, v] of decls(b.body)) for (const u of urlsIn(v)) if (!isAllowedUrl(u)) r.errors.push(`@font-face url refused: ${u} — relative (inside the folder named after the css) or data: only`);
        continue;
      }
      r.errors.push(`at-rule not allowed: ${head} (no @import / @layer / @page …)`);
      continue;
    }
    if (head === ":root") {
      if (outer.length) r.errors.push(":root inside a conditional block");
      for (const [n] of decls(b.body)) if (!n.startsWith("--theme-")) r.errors.push(`:root ${n} — only --theme-* belongs on :root; knobs and colours go on .md-body`);
      continue;
    }
    for (const sel of splitSelectors(head)) {
      if (!isMdSelector(sel)) r.errors.push(`selector outside the fence: "${sel}" — must start at .md-body and stay inside (no top-level + / ~)`);
    }
    for (const lost of lostShorthands(decls(b.body))) {
      r.errors.push(`${head} { ${lost} } — WebKit drops a var() shorthand when a longhand of its family follows; write longhands only (background-image + background-size), or fold the longhand into the shorthand`);
    }
    for (const [n, v] of decls(b.body)) {
      if (n.startsWith("--")) own.add(n);
      for (const u of urlsIn(v)) if (!isAllowedUrl(u)) r.errors.push(`${head} { ${n} } url refused: ${u}`);
      if (LITERAL_COLOUR.test(v) && !/^(--md-hr-mark|content)$/.test(n)) literal.push(`${head} { ${n}: ${v} }`);
    }
  }
  for (const ref of referencedTokens(stripCssComments(t.css))) {
    if (own.has(ref) || ref.startsWith("--md-") || ref.startsWith("--font-")) continue;
    if (!tokenTier(TOKEN_CONTRACT, ref)) r.errors.push(`var(${ref}) resolves to nothing — not an app token, not a --md-* knob, not declared in this file`);
  }
  if (literal.length) {
    r.warnings.push(`${literal.length} literal colour(s) — the card will say "own colours · does not follow the appearance", and they will not flip for dark. Prefer var(--md-color-*) / var(--color-*) unless that is the intent:\n      ${literal.slice(0, 8).join("\n      ")}${literal.length > 8 ? "\n      …" : ""}`);
  }
  if (!t.meta["--theme-extends"]) r.warnings.push("--theme-extends not written — falls back to manuscript (serif, centred headings, 2em indent); say the base you mean");
}

// ── preview ──────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = { ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif" };

/** Relative url()s → data:, as install and export do. */
function inlineAssets(css: string, dir: string): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, _q, target: string) => {
    if (/^data:/i.test(target) || !isAllowedUrl(target)) return whole;
    const p = resolve(dir, target);
    if (!existsSync(p)) return whole;
    return `url("data:${MIME[extname(p).toLowerCase()] ?? "application/octet-stream"};base64,${readFileSync(p).toString("base64")}")`;
  });
}

function uiEntry(t: Parsed, tokens: Record<string, string>): ThemeEntry {
  const scheme = t.meta["--theme-scheme"] === "dark" ? "dark" : "light";
  return {
    id: t.id ?? "preview", kind: "ui", name: t.meta["--theme-name"] ?? t.file, scheme,
    extends: BUILTIN_THEME_FOR_SCHEME[scheme], source: "user", problems: [], kept: Object.keys(tokens).length, usable: true, tokens,
  };
}

const SHELL_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { font: 13px/1.5 var(--font-sans); background: var(--color-bg-base); color: var(--color-text-primary); display: flex; flex-direction: column; }
.bar { position: sticky; top: 0; z-index: 1; height: 38px; display: flex; align-items: center; gap: 10px; padding: 0 14px; background: var(--glass-bg-strong); border-bottom: 1px solid var(--color-border); color: var(--color-text-secondary); }
.bar b { color: var(--color-text-primary); font-weight: 600; }
.main { flex: 1; display: flex; align-items: stretch; }
.rail { width: 44px; background: var(--color-bg-surface); border-right: 1px solid var(--color-border-soft); display: flex; flex-direction: column; align-items: center; gap: 10px; padding-top: 12px; }
.rail i { width: 22px; height: 22px; border-radius: 6px; background: var(--color-bg-hover); }
.rail i.on { background: var(--color-accent-tint-strong); outline: 1px solid var(--color-sienna); }
.side { width: 190px; background: var(--color-bg-surface); border-right: 1px solid var(--color-border); padding: 10px 8px; }
.side h6 { margin: 4px 8px 8px; font-size: 11px; font-weight: 600; letter-spacing: .06em; color: var(--color-text-muted); }
.row { padding: 5px 8px; border-radius: 6px; color: var(--color-text-secondary); }
.row.hover { background: var(--color-bg-hover); }
.row.on { background: var(--color-accent-tint); color: var(--color-sienna); }
.row small { color: var(--color-text-faint); float: right; }
.doc { flex: 1; min-width: 0; padding: 28px 40px; }
.doc [id] { scroll-margin-top: 56px; }
.doc .md-body { --md-size: 16px; max-width: 680px; margin: 0 auto; }
.ai { width: 250px; background: var(--color-bg-surface); border-left: 1px solid var(--color-border); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.card { background: var(--color-bg-elevated); border: 1px solid var(--color-border-soft); border-radius: 10px; padding: 10px; color: var(--color-text-secondary); }
.pop { background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: 10px; padding: 10px; box-shadow: var(--shadow-lg); }
.btn { border: 0; border-radius: 8px; padding: 6px 12px; font: inherit; background: var(--color-sienna); color: var(--color-on-accent); }
.btn.h { background: var(--color-sienna-hover); }
.btn.t { background: var(--color-accent-tint); color: var(--color-sienna); }
.inp { border: 1px solid var(--color-border); border-radius: 8px; padding: 6px 8px; background: var(--color-bg-base); color: var(--color-text-ghost); }
.inp.f { border-color: var(--color-sienna); box-shadow: 0 0 0 2px var(--color-accent-tint-strong); color: var(--color-text-primary); }
.tags { display: flex; flex-wrap: wrap; gap: 5px; }
.tag { font-size: 11px; padding: 1px 7px; border-radius: 99px; }
.dots span { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
.strong { border-top: 1px solid var(--color-border-strong); padding-top: 6px; color: var(--color-amber); }
.soft { background: var(--color-amber-soft); border-radius: 6px; padding: 2px 6px; }
`;

const TYPES = ["text", "multimodal", "image", "video", "vision", "asr"];
const IMG = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#8aa"/><stop offset="1" stop-color="#cba"/></linearGradient></defs><rect width="640" height="200" fill="url(#g)"/></svg>')}`;

const DOC = `
<h1>渡口纪事 The Ferry</h1>
<p>船到渡口时天还没亮，河面浮着一层白气。<strong>老船工</strong>把缆绳绕了两圈，说这水<em>比往年急</em>，又指了指对岸的<a href="#">灯塔</a>。The boat reached the ferry before dawn; a white mist lay on the river, and <code>inline code</code> sits in a sentence like this, next to <del>struck text</del>.</p>
<h2>第一节 水位 Water level</h2>
<p>第二段用来看段距与首行缩进。那年的水位比现在高三尺，码头的石阶有一半在水下，孩子们就坐在露出水面的那几级上钓鱼。</p>
<blockquote id="quote"><p>那年的水位比现在高三尺。</p><p>— 县志，卷四</p></blockquote>
<h3 id="lists">1.1 清单 Lists</h3>
<ul><li>缆绳两圈<ul><li>第二层<ul><li>第三层</li></ul></li></ul></li><li>灯油一壶</li><li>A line in English to see Latin glyphs beside CJK</li></ul>
<ol><li>解缆</li><li>撑篙<ol><li>先左</li><li>后右</li></ol></li><li>靠岸</li></ol>
<h4 id="code">1.1.1 代码 Code</h4>
<pre><code>function ferry(level: number) {
  return level &gt; 3 ? "wait" : "cross"; // 水位高就等
}</code></pre>
<h3 id="table">1.2 表格 Table</h3>
<table><thead><tr><th>年份</th><th>水位</th><th>备注</th></tr></thead><tbody><tr><td>1931</td><td>三丈二</td><td>漫过石阶</td></tr><tr><td>1954</td><td>三丈五</td><td>渡口停摆</td></tr><tr><td>1998</td><td>三丈一</td><td>—</td></tr></tbody></table>
<hr>
<h5>五级标题 h5</h5><h6>六级标题 h6</h6>
<p><img src="${IMG}" alt="示意图"></p>
<p>最后一段，收尾。</p>`;

/** One full page: the shell mock around the sample document. */
function frame(scheme: ColorScheme, ui: ThemeEntry, mdBase: MarkdownThemeId, userMdCss: string, title: string): string {
  const base = markdownThemeCss(mdBase, ".md-body");
  const palette = exportPaletteCss(ui, ui, `${base}\n${userMdCss}\n${SHELL_CSS}`, TOKEN_CONTRACT, scheme);
  const tags = TYPES.map((k) => `<span class="tag" style="background:var(--color-type-${k}-bg);color:var(--color-type-${k}-fg)">${k}</span>`).join("");
  // The base goes in a layer so the theme file always wins, as the app's
  // html[data-md-theme] prefix makes it win there.
  const doc = `<!DOCTYPE html><html data-md-theme="${mdBase}"><head><meta charset="utf-8"><style>
@layer base;
${palette}
${SHELL_CSS}
@layer base { ${base} }
${userMdCss}
</style></head><body>
<div class="bar"><b>${title}</b><span>· ${scheme}</span></div>
<div class="main">
  <div class="rail"><i class="on"></i><i></i><i></i></div>
  <div class="side"><h6>文档 FILES</h6><div class="row on">渡口纪事.md <small>2k</small></div><div class="row hover">hover 行.md</div><div class="row">第三章.md <small>faint</small></div><div class="row" style="color:var(--color-text-muted)">muted 行</div></div>
  <div class="doc"><div class="md-body">${DOC}</div></div>
  <div class="ai">
    <div class="card">elevated 卡片 · secondary text</div>
    <div class="pop">surface 浮层 + shadow-lg</div>
    <div><button class="btn">主按钮</button> <button class="btn h">hover</button> <button class="btn t">tinted</button></div>
    <div class="inp">占位 ghost</div><div class="inp f">聚焦 focus ring</div>
    <div class="tags">${tags}</div>
    <div class="dots"><span style="background:var(--color-success)"></span><span style="background:var(--color-warning)"></span><span style="background:var(--color-error)"></span> status</div>
    <div class="strong">border-strong · amber <span class="soft">amber-soft</span></div>
  </div>
</div></body></html>`;
  return doc;
}

type Partner = [Parsed, Record<string, string>];

function writePreview(t: Parsed, tokens: Record<string, string>, partners: Partner[], root: string): string {
  const builtin = (s: ColorScheme) => BUILTIN_UI_THEMES.find((e) => e.id === BUILTIN_THEME_FOR_SCHEME[s]) as ThemeEntry;
  const mdOf = (p: Parsed | null): [MarkdownThemeId, string] =>
    p ? [((p.meta["--theme-extends"] ?? "manuscript").trim() as MarkdownThemeId), inlineAssets(p.css, dirname(p.path))] : ["clean", ""];
  // Each frame is a file of its own rather than an <iframe srcdoc>: vite's dev
  // server injects its client script into the first <head> it sees, and inside
  // a srcdoc attribute that tears the markup apart.
  const frames: [ColorScheme, string][] = [];
  if (t.kind === "ui") {
    const [base, css] = mdOf(partners.find(([p]) => p.kind === "markdown")?.[0] ?? null);
    const e = uiEntry(t, tokens);
    frames.push([e.scheme as ColorScheme, frame(e.scheme as ColorScheme, e, base, css, String(e.name))]);
  } else {
    const [base, css] = mdOf(t);
    const uis = partners.filter(([p]) => p.kind === "ui").map(([p, tk]) => uiEntry(p, tk));
    for (const s of ["light", "dark"] as const) {
      const ui = uis.find((e) => e.scheme === s) ?? builtin(s);
      frames.push([s, frame(s, ui, base, css, `${t.meta["--theme-name"] ?? t.file} × ${typeof ui.name === "string" ? ui.name : ui.name.zh}`)]);
    }
  }
  const dir = resolve(root, "previews.local");
  mkdirSync(dir, { recursive: true });
  const stem = t.id ?? "theme";
  const outs = frames.map(([s, html]) => {
    const out = resolve(dir, `${stem}.${s}.html`);
    writeFileSync(out, html);
    return out;
  });
  return outs.join("\n            ");
}

// ── entry ────────────────────────────────────────────────────────────────────

export async function main(argv: string[], root: string): Promise<number> {
  const files: string[] = [];
  const withPaths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--with") withPaths.push(argv[++i]);
    else if (!argv[i].startsWith("--")) files.push(argv[i]);
  }
  if (files.length !== 1) {
    console.error("usage: check-theme.mjs <theme.css> [--preview] [--with <partner.css>]… (--with repeats: a light and a dark appearance)");
    return 2;
  }
  const run = (path: string): [Parsed, Report] => {
    const t = parse(resolve(root, path));
    const r: Report = { errors: [], warnings: [], info: [], tokens: {} };
    checkCommon(t, r);
    if (t.kind === "ui") checkUi(t, r);
    else checkMarkdown(t, r);
    return [t, r];
  };
  const [t, r] = run(files[0]);
  console.log(`${t.file} — ${t.kind === "ui" ? `appearance theme (${t.meta["--theme-scheme"] ?? "?"})` : `typography theme (extends ${t.meta["--theme-extends"] ?? "manuscript"})`} · "${t.meta["--theme-name"] ?? "?"}"`);
  for (const e of r.errors) console.log(`  ✗ ${e}`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
  for (const i of r.info) console.log(`  ✓ ${i}`);
  if (!r.errors.length && !r.warnings.length) console.log("  ✓ clean — the app would keep every rule");

  if (argv.includes("--preview")) {
    const partners: Partner[] = [];
    for (const w of withPaths) {
      const [p, pr] = run(w);
      partners.push([p, pr.tokens]);
      if (p.kind === t.kind) console.log(`  ! --with is the same kind (${p.kind}); it is ignored — pair an appearance theme with a typography theme`);
    }
    const out = writePreview(t, r.tokens, partners, root);
    console.log(`  preview → ${out}`);
  }
  return r.errors.length ? 1 : 0;
}
