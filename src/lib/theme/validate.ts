/**
 * The theme-file validators (docs/feature/theme-system-plan.md §5).
 *
 * Two kinds of file, two sets of rules, one walker shape:
 *
 * - A **ui theme is tokens, not a stylesheet**: the only thing it may do is
 *   set custom properties the app declares, on the one selector that carries
 *   a theme. Everything else is dropped.
 * - A **markdown theme is a stylesheet fenced inside `.md-body`** (Typora's
 *   `#write`): any rule whose every selector starts there **and stays there**
 *   (no sibling combinator walking back out), `@media` /
 *   `@supports` / `@container` recursing to the same test, `@font-face` and
 *   `@keyframes` as they are. `url()` only relative or `data:` — a remote
 *   `url()` is the half of a CSS keylogger the CSP would block anyway, and
 *   the validator says so here rather than letting it fail silently.
 *
 * Dropping is per rule (or per declaration), never per file: a theme with
 * three stray rules is a theme with three problems, each carrying the rule it
 * sat in, the selector and a reason the card can show (设计稿 05i 屏 1c / 1d).
 *
 * The walk runs over the shape of a `CSSRuleList`, not over text — the parser
 * is the browser's, so what passes here is exactly what will render, and a
 * regex over selectors was rejected in the plan for the reasons regexes over
 * selectors always are. The shape is typed structurally (`RuleLike`) so the
 * tests can feed plain objects: vitest runs in node, where there is no CSSOM.
 * `parseCssRules` is the one DOM-touching function.
 *
 * The output is never the file with rules deleted; it is regenerated from
 * the kept rules. The file on disk is never rewritten — the card's footer
 * promises the author that in so many words.
 */
import { THEME_META_PREFIX, type ThemeKind, type ThemeProblem, type ThemeReasonCode } from "./manifest";
import { tokenTier, type TokenContract } from "./contract";

// CSSRule.type constants — numeric, and the same in every engine. Newer
// at-rules (`@container`, `@layer`) report 0 and are told apart by cssText.
const STYLE_RULE = 1;
const MEDIA_RULE = 4;
const FONT_FACE_RULE = 5;
const KEYFRAMES_RULE = 7;
const SUPPORTS_RULE = 12;

export interface StyleLike {
  length: number;
  item(index: number): string;
  getPropertyValue(name: string): string;
  getPropertyPriority?(name: string): string;
  /**
   * The block serialised by the engine, and the way to take a declaration
   * out of it. The CSSOM enumerates `background: #fff` as eight longhands,
   * but serialises the block back with the shorthand restored — so the
   * walker judges declaration by declaration, removes what it refused, and
   * emits `cssText` rather than re-joining the longhands itself.
   */
  cssText?: string;
  removeProperty?(name: string): string;
}

export interface RuleLike {
  type: number;
  selectorText?: string;
  conditionText?: string;
  cssText?: string;
  style?: StyleLike;
  cssRules?: ArrayLike<RuleLike>;
}

/** The two selectors a ui theme may write on; `:root` is rewritten to the other. */
export function isThemeSelector(selector: string, id: string): boolean {
  const s = selector.trim();
  return s === ":root" || s === `[data-theme="${id}"]` || s === `[data-theme='${id}']`;
}

export const MD_ROOT = ".md-body";

/**
 * Every kept selector is emitted behind this prefix. A theme file sits on a
 * built-in base whose rules are keyed `[data-md-theme="x"] .md-body …` —
 * one attribute selector more specific than the file's own `.md-body …`, so
 * without the prefix `--md-line: 1.9` in the file would lose to the base's
 * `1.78` on specificity alone, whatever the source order. The prefix adds
 * (0,1,1) and lets the file win the way an author expects a later sheet to.
 * Safe to add because it is prepended to a selector the browser already
 * parsed and this validator already confirmed starts at `.md-body` — not a
 * regex rewrite in the middle of one. The app's `<html>` carries the
 * attribute whenever a theme is applied; the export and the samples set it
 * on theirs (`fs/export.ts`, `sample.ts`).
 */
export const MD_SCOPE_PREFIX = "html[data-md-theme]";

/** The codes this walker emits; the locale files carry the sentences. */
export const REASON = {
  selector: "uiSelector",
  property: "uiProperty",
  scale: "uiScale",
  unknown: "uiUnknown",
  schemeMedia: "uiSchemeMedia",
  atRule: "uiAtRule",
  mdSelector: "mdSelector",
  mdCombinator: "mdCombinator",
  mdRoot: "mdRoot",
  mdAtRule: "mdAtRule",
  mdUrl: "mdUrl",
} as const satisfies Record<string, ThemeReasonCode>;

// ─── The metadata pre-pass ───────────────────────────────────────────────────

/**
 * Every `--theme-*` pair in the file, wherever it sits — the kind has to be
 * known before the right validator can run, and a markdown theme's header is
 * accepted on `:root` as well as on `.md-body` so both kinds of file can
 * start the same way.
 */
export function readMetaPairs(rules: ArrayLike<RuleLike>): Record<string, string> {
  const meta: Record<string, string> = {};
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.type !== STYLE_RULE || !rule.style) continue;
    const style = rule.style;
    for (let d = 0; d < style.length; d++) {
      const name = style.item(d);
      if (name.startsWith(THEME_META_PREFIX)) meta[name] = style.getPropertyValue(name).trim();
    }
  }
  return meta;
}

/** The kind a file declares, read before validation; anything but `markdown` is ui. */
export function themeKindOf(rules: ArrayLike<RuleLike>): ThemeKind {
  return readMetaPairs(rules)[`${THEME_META_PREFIX}kind`]?.trim().replace(/^["']|["']$/g, "") === "markdown"
    ? "markdown"
    : "ui";
}

// ─── ui themes ───────────────────────────────────────────────────────────────

export interface UiThemeValidation {
  kind: "ui";
  /** The `--theme-*` pairs, raw — `readThemeMeta` interprets them. */
  meta: Record<string, string>;
  /** Kept declarations: contract tokens, later rules winning. */
  tokens: Record<string, string>;
  problems: ThemeProblem[];
  /** Declarations kept — the 「其余 N 条已生效」 count. */
  kept: number;
}

/**
 * Walk a parsed ui theme and keep what the contract allows.
 *
 * Top-level style rules on the theme selector: each `--theme-*` declaration is
 * metadata, each contract token is kept, a scale token / unknown name / plain
 * property is dropped with its own reason. Every other top-level rule is
 * dropped whole — `@media (prefers-color-scheme)` with the reason that matters
 * (the theme's polarity is the file's to declare, not the OS's), the rest as
 * out of bounds.
 */
export function validateUiRules(
  rules: ArrayLike<RuleLike>,
  id: string,
  contract: Pick<TokenContract, "scale" | "core" | "derived">,
): UiThemeValidation {
  const meta: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const problems: ThemeProblem[] = [];
  let kept = 0;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const n = i + 1;
    if (rule.type !== STYLE_RULE) {
      const isSchemeMedia =
        rule.type === MEDIA_RULE && /prefers-color-scheme/.test(rule.conditionText ?? rule.cssText ?? "");
      problems.push({ rule: n, selector: atRuleHead(rule), reason: isSchemeMedia ? REASON.schemeMedia : REASON.atRule });
      continue;
    }
    const selector = rule.selectorText ?? "";
    if (!isThemeSelector(selector, id)) {
      problems.push({ rule: n, selector, reason: REASON.selector });
      continue;
    }
    const style = rule.style;
    if (!style) continue;
    for (let d = 0; d < style.length; d++) {
      const name = style.item(d);
      const value = style.getPropertyValue(name).trim();
      if (name.startsWith(THEME_META_PREFIX)) {
        meta[name] = value;
        continue;
      }
      if (!name.startsWith("--")) {
        problems.push({ rule: n, selector: `${selector} ${name}`, reason: REASON.property });
        continue;
      }
      const tier = tokenTier(contract, name);
      if (tier === "core" || tier === "derived") {
        tokens[name] = value;
        kept++;
      } else {
        problems.push({
          rule: n,
          selector: `${selector} ${name}`,
          reason: tier === "scale" ? REASON.scale : REASON.unknown,
        });
      }
    }
  }
  return { kind: "ui", meta, tokens, problems, kept };
}

/**
 * The installed form of a validated ui theme: one block on its own selector.
 * Values are emitted verbatim — the browser already parsed them once, and a
 * value it refused never reached `tokens`.
 */
export function uiThemeCss(id: string, tokens: Record<string, string>): string {
  const body = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join("\n");
  return `[data-theme="${cssString(id)}"] {\n${body}\n}`;
}

/** An id inside a double-quoted attribute selector. */
export function cssString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ─── markdown themes ─────────────────────────────────────────────────────────

export interface MarkdownThemeValidation {
  kind: "markdown";
  meta: Record<string, string>;
  /** The kept rules, regenerated; relative `url()`s left relative (see assets.ts). */
  css: string;
  /** Relative paths the CSS references — the theme's asset folder, by Typora's convention. */
  assets: string[];
  problems: ThemeProblem[];
  /** Top-level rules kept. */
  kept: number;
  /** Names a font family of its own (a literal, not `var(--font-*)`) — 「自带字体」. */
  ownFonts: boolean;
  /** Sets a literal colour or ground — 「自带颜色 · 不随外观变」. */
  ownColors: boolean;
}

const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]*))\s*\)/g;

/** Every `url()` target in a value. */
export function urlsIn(value: string): string[] {
  return [...value.matchAll(URL_RE)].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").trim());
}

/** Relative (into the theme's folder) or `data:`; everything else is refused. */
export function isAllowedUrl(target: string): boolean {
  if (/^data:/i.test(target)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  if (target.startsWith("/") || target.startsWith("\\") || target.startsWith("#")) return false;
  if (target.split(/[\\/]/).includes("..")) return false;
  return target.length > 0;
}

/** Split a selector list on top-level commas — `:is(a, b)` stays whole. */
export function splitSelectors(selectorText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of selectorText) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const MD_ROOT_RE = new RegExp(`^${MD_ROOT.replace(".", "\\.")}(?![\\w-])`);

/** Does it *start* at `.md-body` — the first half of the fence. */
export function startsAtMdRoot(selector: string): boolean {
  return MD_ROOT_RE.test(selector.trim());
}

/**
 * Does it also **stay** inside — the other half, and the one a regex anchored
 * at the head cannot see.
 *
 * `.md-body ~ *` and `.md-body + .toolbar` both start at `.md-body` and then
 * walk sideways out of it: they select the preview container's *siblings*,
 * which is app chrome (the lore read view puts its mono meta line right next
 * to the rendered body; the editor puts its toolbar there). `!important` is
 * kept on the way out, so a theme file could blank half the window — and a
 * theme file is not always the author's own: a project's `.ai-writer/themes/`
 * may carry typography themes, and one of those overrides a user theme of the
 * same id (`registry.ts`), so a cloned repository can get its CSS installed by
 * being opened. Descendant and `>` stay inside the subtree and are fine.
 *
 * Only combinators at depth 0 count: the `+` in `:nth-child(2n+1)` and the
 * `~=` in an attribute selector are not combinators, and `.md-body:has(+ .x)`
 * still has `.md-body` as its subject.
 */
export function staysInsideMdRoot(selector: string): boolean {
  let depth = 0;
  for (const ch of selector) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && (ch === "~" || ch === "+")) return false;
  }
  return true;
}

export function isMdSelector(selector: string): boolean {
  const sel = selector.trim();
  return startsAtMdRoot(sel) && staysInsideMdRoot(sel);
}

const FONT_PROPS = /^(font|font-family|--md-font-[\w-]+)$/;
const COLOR_PROPS = /^(color|background|background-color|--md-color-[\w-]+|--md-quote-bg)$/;

/**
 * Walk a parsed markdown theme and keep what the fence allows.
 *
 * `:root` is accepted for `--theme-*` metadata only (so both kinds of file
 * can open the same way); a colour written there is dropped with a reason
 * pointing at `.md-body`. Rules inside `@media` / `@supports` / `@container`
 * are held to the same selector test and the container is re-emitted around
 * what survived. Problems inside a nested block carry the *top-level* rule
 * number, which is what the author can count in the file.
 */
export function validateMarkdownRules(rules: ArrayLike<RuleLike>): MarkdownThemeValidation {
  const meta: Record<string, string> = {};
  const problems: ThemeProblem[] = [];
  const assets = new Set<string>();
  let ownFonts = false;
  let ownColors = false;
  let kept = 0;

  /**
   * The declarations of one block, judged one by one, returned as the block
   * text the engine serialises after the refused ones are removed — which
   * is how `background: #fff` comes back as one declaration and not eight.
   * Falls back to re-joining the kept longhands where the engine offers no
   * `cssText` (the tests' plain objects). Empty string = nothing kept.
   */
  const declarations = (style: StyleLike, selector: string, n: number, opts: { root?: boolean }): string => {
    const kept: string[] = [];
    const dropped: string[] = [];
    // Snapshot first: removing while iterating shifts the indices.
    const names: string[] = [];
    for (let d = 0; d < style.length; d++) names.push(style.item(d));
    for (const name of names) {
      const value = style.getPropertyValue(name).trim();
      if (name.startsWith(THEME_META_PREFIX)) {
        meta[name] = value;
        dropped.push(name);
        continue;
      }
      if (opts.root) {
        problems.push({ rule: n, selector: `${selector} ${name}`, reason: REASON.mdRoot });
        dropped.push(name);
        continue;
      }
      const urls = urlsIn(value);
      if (urls.some((u) => !isAllowedUrl(u))) {
        problems.push({ rule: n, selector: `${selector} ${name}`, reason: REASON.mdUrl });
        dropped.push(name);
        continue;
      }
      for (const u of urls) if (!/^data:/i.test(u)) assets.add(u);
      const literal = !/var\(/.test(value);
      if (literal && FONT_PROPS.test(name)) ownFonts = true;
      if (literal && COLOR_PROPS.test(name)) ownColors = true;
      const priority = style.getPropertyPriority?.(name);
      kept.push(`${name}: ${value}${priority === "important" ? " !important" : ""};`);
    }
    if (!kept.length) return "";
    if (style.removeProperty && typeof style.cssText === "string") {
      for (const name of dropped) style.removeProperty(name);
      return style.cssText.trim();
    }
    return kept.join(" ");
  };

  const walk = (list: ArrayLike<RuleLike>, topLevel: boolean, parentN: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const rule = list[i];
      const n = topLevel ? i + 1 : parentN;
      const head = atRuleHead(rule);
      if (rule.type === STYLE_RULE) {
        const selector = rule.selectorText ?? "";
        const isRoot = selector.trim() === ":root";
        if (!isRoot) {
          const parts = splitSelectors(selector);
          // Two different mistakes, two different sentences: one is "this rule
          // is not about the rendered document at all", the other is "it starts
          // there and then steps out sideways" — and only the second reads as a
          // fence the author did not know was there.
          if (!parts.every(startsAtMdRoot)) {
            problems.push({ rule: n, selector, reason: REASON.mdSelector });
            continue;
          }
          if (!parts.every(staysInsideMdRoot)) {
            problems.push({ rule: n, selector, reason: REASON.mdCombinator });
            continue;
          }
        }
        const decls = rule.style ? declarations(rule.style, selector, n, { root: isRoot }) : "";
        if (!decls) continue;
        const scoped = splitSelectors(selector).map((sel) => `${MD_SCOPE_PREFIX} ${sel}`).join(", ");
        out.push(`${scoped} { ${decls} }`);
        if (topLevel) kept++;
      } else if (rule.type === FONT_FACE_RULE) {
        ownFonts = true;
        const decls = rule.style ? declarations(rule.style, "@font-face", n, {}) : "";
        // A face whose `src` was refused (a remote or absolute url) is no face
        // at all; the problem is already recorded, the rule goes with it.
        if (!/(^|\s)src:/.test(decls)) continue;
        out.push(`@font-face { ${decls} }`);
        if (topLevel) kept++;
      } else if (rule.type === KEYFRAMES_RULE) {
        if (rule.cssText) out.push(rule.cssText);
        if (topLevel) kept++;
      } else if (rule.type === MEDIA_RULE || rule.type === SUPPORTS_RULE || /^@container\b/.test(head)) {
        const inner = walk(rule.cssRules ?? [], false, n);
        if (!inner.length) continue;
        out.push(`${head} {\n${inner.join("\n")}\n}`);
        if (topLevel) kept++;
      } else {
        problems.push({ rule: n, selector: head, reason: REASON.mdAtRule });
      }
    }
    return out;
  };

  const css = walk(rules, true, 0).join("\n\n");
  return { kind: "markdown", meta, css, assets: [...assets], problems, kept, ownFonts, ownColors };
}

export type ThemeValidation = UiThemeValidation | MarkdownThemeValidation;

/** Decide the kind from the header, then run that kind's walk. */
export function validateThemeRules(
  rules: ArrayLike<RuleLike>,
  id: string,
  contract: Pick<TokenContract, "scale" | "core" | "derived">,
): ThemeValidation {
  return themeKindOf(rules) === "markdown" ? validateMarkdownRules(rules) : validateUiRules(rules, id, contract);
}

function atRuleHead(rule: RuleLike): string {
  const head = (rule.cssText ?? "").trim().split("{")[0].trim();
  return head || `@rule ${rule.type}`;
}

// ─── DOM ─────────────────────────────────────────────────────────────────────

/**
 * Parse `text` with the browser's own CSS parser and hand back its rules.
 *
 * A disabled `<style>` element rather than a constructed `CSSStyleSheet`: the
 * constructor arrived in WebKit 16.4, above the floor `webviewCaps.ts` targets
 * (WebKit 16), while a `<style>` has always parsed and exposed `sheet`.
 * `media="not all"` keeps it from painting for the one frame it is attached;
 * it is removed before this returns. The rules are copied into an array so
 * the caller never holds a reference into a detached sheet.
 */
export function parseCssRules(text: string): RuleLike[] {
  const el = document.createElement("style");
  el.media = "not all";
  el.textContent = text;
  document.head.appendChild(el);
  try {
    const sheet = el.sheet;
    if (!sheet) return [];
    const out: RuleLike[] = [];
    const list = sheet.cssRules;
    for (let i = 0; i < list.length; i++) out.push(list[i] as unknown as RuleLike);
    return out;
  } finally {
    el.remove();
  }
}

/** `parseCssRules` + `validateThemeRules` — the DOM entry point. */
export function validateThemeText(
  text: string,
  id: string,
  contract: Pick<TokenContract, "scale" | "core" | "derived">,
): ThemeValidation {
  return validateThemeRules(parseCssRules(text), id, contract);
}

/** ui only — kept for callers that already know the kind. */
export function validateUiThemeText(
  text: string,
  id: string,
  contract: Pick<TokenContract, "scale" | "core" | "derived">,
): UiThemeValidation {
  return validateUiRules(parseCssRules(text), id, contract);
}
