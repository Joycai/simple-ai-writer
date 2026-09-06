/**
 * The appearance-theme validator (docs/feature/theme-system-plan.md §5).
 *
 * A ui theme is **tokens, not a stylesheet**: the only thing it may do is set
 * custom properties the app declares, on the one selector that carries a
 * theme. Everything else is dropped — and counted, with the rule it sat in,
 * the selector, and a reason the card can show (设计稿 05i 屏 1c / 1d). Nothing
 * is ever refused whole: a file with three stray rules is a theme with three
 * problems, not a broken theme.
 *
 * The walk runs over the shape of a `CSSRuleList`, not over text — the parser
 * is the browser's, so what passes here is exactly what will render, and a
 * regex over selectors was rejected in the plan for the reasons regexes over
 * selectors always are. The shape is typed structurally (`RuleLike`) so the
 * tests can feed plain objects: vitest runs in node, where there is no CSSOM.
 * `parseCssRules` is the one DOM-touching function.
 *
 * The output is not the file with rules deleted; it is a fresh `[data-theme]`
 * block regenerated from the kept declarations. The file on disk is never
 * rewritten — the card's footer promises the author that in so many words.
 */
import { THEME_META_PREFIX, type ThemeProblem } from "./manifest";
import { tokenTier, type TokenContract } from "./contract";

// CSSRule.type constants — numeric, and the same in every engine.
const STYLE_RULE = 1;
const MEDIA_RULE = 4;

export interface StyleLike {
  length: number;
  item(index: number): string;
  getPropertyValue(name: string): string;
}

export interface RuleLike {
  type: number;
  selectorText?: string;
  conditionText?: string;
  cssText?: string;
  style?: StyleLike;
}

export interface UiThemeValidation {
  /** The `--theme-*` pairs, raw — `readThemeMeta` interprets them. */
  meta: Record<string, string>;
  /** Kept declarations: contract tokens, later rules winning. */
  tokens: Record<string, string>;
  problems: ThemeProblem[];
  /** Declarations kept — the 「其余 N 条已生效」 count. */
  kept: number;
}

/** The two selectors a ui theme may write on; `:root` is rewritten to the other. */
export function isThemeSelector(selector: string, id: string): boolean {
  const s = selector.trim();
  return s === ":root" || s === `[data-theme="${id}"]` || s === `[data-theme='${id}']`;
}

/** Wording lives here so the tests and the card cannot drift apart. */
export const REASON = {
  selector: "越界 · 只读 :root 里的令牌声明",
  property: "越界 · 布局与字号不由外观主题决定",
  scale: "越界 · 间距、圆角、字体是刻度，不由外观主题决定",
  unknown: "未知令牌 · 应用没有这个令牌",
  schemeMedia: "越界 · 明暗由 --theme-scheme 决定，不由系统决定",
  atRule: "越界 · 外观主题只有令牌声明",
} as const;

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
      problems.push({
        rule: n,
        selector: atRuleLabel(rule),
        reason: isSchemeMedia ? REASON.schemeMedia : REASON.atRule,
      });
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
  return { meta, tokens, problems, kept };
}

function atRuleLabel(rule: RuleLike): string {
  const head = (rule.cssText ?? "").trim().split("{")[0].trim();
  return head || `@rule ${rule.type}`;
}

/**
 * The installed form of a validated theme: one block on its own selector.
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

/** `parseCssRules` + `validateUiRules` — the DOM entry point. */
export function validateUiThemeText(
  text: string,
  id: string,
  contract: Pick<TokenContract, "scale" | "core" | "derived">,
): UiThemeValidation {
  return validateUiRules(parseCssRules(text), id, contract);
}
