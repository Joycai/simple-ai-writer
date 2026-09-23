/**
 * The settings page's typography samples — one small document per card.
 *
 * Each card is a sandboxed `<iframe srcdoc>` (docs/feature/theme-system-plan.md
 * §7.3): the settings page remaps every `--color-*` to its own `--stg-*`
 * palette, so a sample drawn in the page would be dyed by it, and a theme
 * *file* cannot be pinned to one container the way the generator used to pin
 * the built-ins. A frame of its own gets the export's exact stylesheet — the
 * palette of the appearance theme in force, the built-in base, the file's
 * own CSS with its assets inlined — and a page of real sample text. What the
 * card shows is what the export produces. Never `allow-same-origin`: the
 * frame is a picture, and the pptx harvester's discipline applies.
 *
 * The palette is pinned to the app's current scheme rather than left to the
 * frame's `prefers-color-scheme`, which is the OS's, not the author's mode;
 * a theme that brings its own colours keeps them either way (1e). The font
 * scheme (`data-font`) reaches the frame as its `--font-*` stacks — an
 * opaque origin cannot load the app's bundled faces (`font-src 'self'` does
 * not apply to it), so the 手稿 scheme's Spectral falls to its Georgia /
 * Songti fallbacks here, while 宋 / 黑 / 楷 name system faces and show as
 * they are. A downloaded pack (鸿蒙黑体 / MiSans) is different: its faces are
 * served by the `ai-writer-font:` scheme, which the CSP names explicitly and
 * which answers with `Access-Control-Allow-Origin: *`, so the caller hands its
 * `@font-face` rules in as `faces` and the frame draws the real glyphs.
 */
import { TOKEN_CONTRACT } from "./contractData";
import { exportPaletteCss } from "./export";
import { markdownThemeCss, type MarkdownThemeId } from "./markdownThemes";
import type { ThemeEntry } from "./registry";
import type { ColorScheme } from "./scheme";

const SAMPLE_TEXT = {
  zh: {
    h: "第三章 · 渡口", p: "船到渡口时天还没亮，河面浮着一层白气。", q: "那年的水位比现在高三尺。",
    p2: "对岸的灯还亮着，像有人守了一夜。他把缆绳绕上木桩，回头看了一眼来路。",
  },
  en: {
    h: "Chapter Three", p: "The boat reached the ferry before dawn; a white mist lay on the river.",
    q: "The water stood three feet higher that year.",
    p2: "A lamp still burned on the far bank, as if someone had kept watch all night.",
  },
} as const;

/**
 * How big a sample is drawn. A card is a thumbnail — 10px text, three pieces;
 * the 外观 page's 「此刻」 window (设计稿 05m) is a page — reading size, and a
 * second paragraph, so the body's grey and its indent actually show.
 */
export interface SampleSize {
  /** `--md-size` in px. */
  size: number;
  padding: string;
  /** Add the second paragraph. */
  long: boolean;
}
const CARD_SAMPLE: SampleSize = { size: 10, padding: "9px 11px", long: false };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The frame's document. `userCss` is the theme file's CSS with assets
 * inlined (empty for a built-in); `appearance` the ui theme in force.
 */
export function sampleDocument(
  entry: ThemeEntry,
  userCss: string,
  appearance: ThemeEntry,
  scheme: ColorScheme,
  isZh: boolean,
  fontScheme?: string,
  sizing: SampleSize = CARD_SAMPLE,
  /** The `@font-face` rules of the font pack `fontScheme` names, if it is one (appStore `fontFaces[scheme]`). */
  faces = "",
): string {
  const baseId = (entry.source === "builtin" ? entry.id : entry.extends) as MarkdownThemeId;
  const md = markdownThemeCss(baseId, "body");
  const palette = exportPaletteCss(appearance, appearance, `${md}\n${userCss}`, TOKEN_CONTRACT, scheme, fontScheme);
  const t = isZh ? SAMPLE_TEXT.zh : SAMPLE_TEXT.en;
  return `<!DOCTYPE html><html data-md-theme="${baseId}"><head><meta charset="utf-8"><style>
${faces}
${palette}
html, body { margin: 0; }
body {
  --md-size: ${sizing.size}px;
  padding: ${sizing.padding};
  background: var(--color-bg-base);
  color: var(--color-text-primary);
  overflow: hidden;
}
${md}
${userCss}
</style></head><body class="md-body"><h2>${esc(t.h)}</h2><p>${esc(t.p)}</p>${sizing.long ? `<p>${esc(t.p2)}</p>` : ""}<blockquote>${esc(t.q)}</blockquote></body></html>`;
}
