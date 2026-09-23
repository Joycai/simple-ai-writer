#!/usr/bin/env node
/**
 * Seed colours → a complete appearance theme (all 41 core tokens).
 *
 *   node palette.mjs --scheme light --accent "#007981" --ground-hue 200 \
 *        --name "薄荷" --id mint [--tint 0.018] [--companion "#449DA2"] \
 *        [--ground "#E5F5F6"] [--contrast 4.6] [--author "…"] [--out path.css]
 *
 * What it does, and why it is a script rather than judgment:
 *   · Neutrals (grounds, text, borders) keep the **lightness ramp** of the
 *     built-in 石 Stone (light) / 墨 Ink (dark) — a ramp already tuned against
 *     every surface of the app — and only swap hue and chroma. Inventing a
 *     ramp by eye is how hover states vanish and borders turn into walls.
 *   · The accent keeps its hue and is moved in lightness until it clears the
 *     contrast target over --color-bg-base, because --color-sienna is a 1px
 *     hairline, a filled button and the focus ring at once.
 *   · Status colours and the six model-type tag pairs are copied from the
 *     built-in: their hues carry meaning (green = ok), a theme should not
 *     re-colour them unless the source really defines them.
 *
 * The output is a starting point: read it, then hand-tune the few tokens the
 * source actually specifies (a particular ground hex, a second colour).
 * No dependencies; runs from anywhere.
 */
import { writeFileSync } from "node:fs";

// ── args ─────────────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i];
}
if (args.help || args.h || process.argv.length <= 2) {
  console.log(`palette.mjs — seed colours → a complete appearance theme (41 core tokens)

  required   --scheme light|dark   --accent "#rrggbb"   --name "显示名"   --id file-id
  ground     --ground "#rrggbb"    the base lands exactly here; the other grounds shift with it
             --ground-hue <0-360>  neutral hue (default: the ground's, else the accent's)
             --tint <chroma>       neutral chroma, ~0.005 grey … 0.02 tinted paper (default 0.014 / 0.012)
             (all three combine: --ground "#ffffff" --ground-hue 250 --tint 0.006 = white base, cold neutrals)
  accent     --companion "#rrggbb" the second colour (default: a lighter shade of the accent)
             --contrast <n>        accent's target over the base (default 4.6)
  output     --out <path.css>      (default: stdout)      --author "…"`);
  process.exit(0);
}
const die = (m) => { console.error(`palette: ${m}`); process.exit(2); };
const scheme = args.scheme;
if (scheme !== "light" && scheme !== "dark") die("--scheme light|dark is required");
if (!/^#[0-9a-f]{6}$/i.test(args.accent ?? "")) die('--accent "#rrggbb" is required');
const name = args.name ?? die("--name is required");
const id = args.id ?? die("--id is required (the file name without .css: lowercase, digits, hyphens)");
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die(`--id "${id}" must be lowercase letters, digits and hyphens`);
const target = Number(args.contrast ?? 4.6);

// ── colour math (sRGB ↔ OKLCH, WCAG contrast) ────────────────────────────────
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function rgbToOklch([r, g, b]) {
  [r, g, b] = [r, g, b].map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI };
}
function oklchToLinRgb({ L, C, h }) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
/** Into gamut by giving up chroma, never hue or lightness. */
function oklchToRgb(c) {
  let C = c.C;
  for (let i = 0; i < 40; i++) {
    const lin = oklchToLinRgb({ ...c, C });
    if (lin.every((v) => v >= -0.0005 && v <= 1.0005)) return lin.map((v) => Math.min(1, Math.max(0, fromLin(Math.min(1, Math.max(0, v))))));
    C *= 0.92;
  }
  return oklchToLinRgb({ ...c, C: 0 }).map((v) => Math.min(1, Math.max(0, fromLin(v))));
}
const rgbToHex = (rgb) => "#" + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
const hex = (c) => rgbToHex(oklchToRgb(c));
const lum = (h) => { const [r, g, b] = hexToRgb(h).map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const rgb255 = (h) => hexToRgb(h).map((v) => Math.round(v * 255)).join(", ");

// ── the built-in ramps (石 Stone / 墨 Ink, from src/styles/tokens.css) ────────
const RAMP = {
  light: {
    "bg-base": "#EEF0F2", "bg-surface": "#F6F7F8", "bg-elevated": "#E3E6EA", "bg-hover": "#D8DCE1",
    "text-primary": "#1E2327", "text-secondary": "#4E555C", "text-muted": "#7A828B", "text-faint": "#A6ADB5", "text-ghost": "#BFC6CD",
    border: "#DCE0E5", "border-soft": "#E5E9ED",
  },
  dark: {
    "bg-base": "#181B1F", "bg-surface": "#13161A", "bg-elevated": "#232730", "bg-hover": "#2C313A",
    "text-primary": "#E3E7EB", "text-secondary": "#B4BCC5", "text-muted": "#8A939D", "text-faint": "#59616B", "text-ghost": "#39404A",
    border: "#262B33", "border-soft": "#262B33",
  },
}[scheme];
const FIXED = {
  light: {
    status: ["#6F9B62", "#B08A3E", "#B0524A"],
    type: { text: ["#E5E8D3", "#63692D"], multimodal: ["#F0DFD2", "#98512E"], image: ["#E9DCEA", "#7C5083"], video: ["#DBE3EE", "#4E6390"], vision: ["#DAE6DC", "#466A4E"], asr: ["#EEDADF", "#8C4458"] },
  },
  dark: {
    status: ["#8CB57E", "#C9A45A", "#D4756B"],
    type: { text: ["rgba(199, 206, 138, 0.18)", "#C8CE8A"], multimodal: ["rgba(224, 150, 110, 0.18)", "#E29A72"], image: ["rgba(196, 150, 200, 0.18)", "#CBA6D3"], video: ["rgba(156, 174, 220, 0.18)", "#9CAEDC"], vision: ["rgba(150, 196, 156, 0.18)", "#9FCBA6"], asr: ["rgba(220, 150, 168, 0.18)", "#DBA2B2"] },
  },
}[scheme];

// ── neutrals: the ramp's lightness, the theme's hue and chroma ───────────────
const accentIn = rgbToOklch(hexToRgb(args.accent));
const groundSeed = args.ground ? rgbToOklch(hexToRgb(args.ground)) : null;
// A white / black / grey ground has no hue of its own — atan2 of two near-zeros
// is noise (it comes out a warm 90°). Borrow the accent's hue instead.
const groundHasHue = groundSeed !== null && groundSeed.C >= 0.004;
const hue = args["ground-hue"] !== undefined ? Number(args["ground-hue"]) : groundHasHue ? groundSeed.h : accentIn.h;
const tint = args.tint !== undefined ? Number(args.tint) : groundSeed ? Math.max(groundSeed.C, 0.004) : scheme === "light" ? 0.014 : 0.012;
// A --ground shifts the whole ramp by its distance from the template's base, so
// the *steps* between surfaces survive while the base lands where the source put it.
const shift = groundSeed ? groundSeed.L - rgbToOklch(hexToRgb(RAMP["bg-base"])).L : 0;
const n = {};
for (const [k, v] of Object.entries(RAMP)) {
  const L = rgbToOklch(hexToRgb(v)).L;
  const isBg = k.startsWith("bg") || k.startsWith("border");
  n[k] = hex({ L: Math.min(0.995, Math.max(0.05, L + (isBg ? shift : 0))), C: tint, h: hue });
}
if (args.ground) n["bg-base"] = args.ground.toUpperCase();

// ── accent: same hue, lightness moved until it reads ─────────────────────────
function pushToContrast(c, ground, want) {
  const dir = scheme === "light" ? -1 : 1;
  let cur = { ...c };
  for (let i = 0; i < 200 && contrast(hex(cur), ground) < want; i++) cur = { ...cur, L: cur.L + dir * 0.004 };
  return cur;
}
const accent = pushToContrast(accentIn, n["bg-base"], target);
const accentHex = hex(accent);
const hoverHex = hex({ ...accent, L: accent.L + (scheme === "light" ? -0.06 : 0.09) });
const comp = args.companion
  ? rgbToOklch(hexToRgb(args.companion))
  : { L: scheme === "light" ? 0.64 : 0.72, C: accent.C * 0.75, h: accent.h };
const compHex = args.companion ? args.companion.toUpperCase() : hex(comp);
const softValue = scheme === "light" ? hex({ L: 0.91, C: Math.min(comp.C, 0.045), h: comp.h }) : `rgba(${rgb255(compHex)}, 0.28)`;

// ── shadows and glass follow the ground ──────────────────────────────────────
const ink = scheme === "light" ? rgb255(n["text-primary"]) : "0, 0, 0";
const glass = rgb255(n["bg-surface"]);
const sh = scheme === "light"
  ? { sm: `0 1px 3px rgba(${ink}, 0.07)`, md: `0 2px 16px rgba(${ink}, 0.11)`, lg: `0 4px 24px rgba(${ink}, 0.11)`, xl: `0 16px 56px rgba(${ink}, 0.24)`, drawer: `-28px 0 56px rgba(${ink}, 0.18)`, overlay: `rgba(${ink}, 0.3)`, g: [0.85, 0.72], gb: `1px solid rgba(${ink}, 0.09)` }
  : { sm: `0 1px 3px rgba(0, 0, 0, 0.40)`, md: `0 4px 16px rgba(0, 0, 0, 0.36)`, lg: `0 8px 32px rgba(0, 0, 0, 0.50)`, xl: `0 16px 56px rgba(0, 0, 0, 0.60)`, drawer: `-28px 0 56px rgba(0, 0, 0, 0.55)`, overlay: `rgba(0, 0, 0, 0.55)`, g: [0.8, 0.62], gb: `1px solid rgba(${rgb255(n["text-primary"])}, 0.07)` };

// ── emit ─────────────────────────────────────────────────────────────────────
const T = [];
const put = (k, v, note) => T.push(`  ${(k + ":").padEnd(28)}${v};${note ? `   /* ${note} */` : ""}`);
const sec = (s) => T.push("", `  /* ${s} */`);
sec("底 / Grounds");
put("--color-bg-base", n["bg-base"]); put("--color-bg-surface", n["bg-surface"]); put("--color-bg-elevated", n["bg-elevated"]);
put("--color-bg-hover", n["bg-hover"]);
put("--color-bg-tinted", scheme === "light" ? n["bg-base"] : n["bg-elevated"], scheme === "light" ? "＝底 / = the ground" : "＝抬起的面 / = the elevated ground");
put("--color-bg-overlay", sh.overlay);
sec("文字 / Text");
for (const k of ["primary", "secondary", "muted", "faint", "ghost"]) put(`--color-text-${k}`, n[`text-${k}`]);
sec("强调 / Accent");
put("--color-sienna", accentHex, "唯一强调色：1px 线、填底、焦点环三用 / the one accent: rules, fills, focus ring");
put("--color-sienna-hover", hoverHex, scheme === "dark" ? "深底上按下＝更亮 / on a dark ground, pressed = lighter" : "");
put("--color-amber", compHex, "第二色 / the companion");
put("--color-amber-soft", softValue);
sec("线 / Rules");
put("--color-border", n.border); put("--color-border-soft", n["border-soft"]);
put("--color-border-strong", scheme === "light" ? compHex : n["text-faint"]);
sec("状态 / Status");
put("--color-success", FIXED.status[0]); put("--color-warning", FIXED.status[1]); put("--color-error", FIXED.status[2]);
sec("模型能力标签 / Model-type tags");
for (const [k, [bg, fg]] of Object.entries(FIXED.type)) { put(`--color-type-${k}-bg`, bg); put(`--color-type-${k}-fg`, fg); }
sec("投影与毛玻璃 / Elevation and glass");
put("--shadow-sm", sh.sm); put("--shadow-md", sh.md); put("--shadow-lg", sh.lg); put("--shadow-xl", sh.xl); put("--shadow-drawer", sh.drawer);
put("--glass-bg", `rgba(${glass}, ${sh.g[0]})`); put("--glass-bg-strong", `rgba(${glass}, ${sh.g[1]})`); put("--glass-border", sh.gb);

const band = scheme === "light" ? ["浅色时", "When light"] : ["深色时", "When dark"];
const css = `/* ════════════════════════════════════════════════════════════════════════════
   ${name} — 外观主题 / an appearance theme

   TODO(作者)：两三句话写清楚这套颜色从哪来、为什么是这个强调色。
   TODO(author): two or three sentences — where the colours come from, why this accent.

   怎么用 / How to use
     1. 设置 → 外观 → 「打开主题文件夹」，把这个文件放进去。
        Settings → Appearance → "Open themes folder", drop it in.
        外观主题只能装在这里；项目的 .ai-writer/themes/ 只收排版主题。
        Appearance themes install here only; a project's .ai-writer/themes/
        takes typography themes.
     2. 设置页开着时文件夹是被监听的，卡片自己出现；否则点「重新载入」。
        The folder is watched while Settings is open; otherwise hit Reload.
     3. 在「外观主题」里选中它——它排在「${band[0]}」那一档。
        Pick it under "Appearance themes", in the "${band[1]}" band.

   改它 / Making it yours
     · 文件名就是主题 id（${id}.css → ${id}）。复制一份改个名，就是新主题。
       The file name is the theme id. Copy and rename = a new theme.
     · 只有下面这 41 个核心令牌要写，其余两百多个界面颜色应用自己按公式推。
       Only the 41 core tokens below need writing — the app derives the rest.
     · 写别的（别的选择器、普通 CSS 属性、@media）会被逐条丢弃并在设置卡片上
       列出原因，文件本身永远不会被改写。
       Anything else (other selectors, plain properties, @media) is dropped
       rule by rule and listed on the settings card; the file is never rewritten.
   ════════════════════════════════════════════════════════════════════════════ */

/* ── 元数据 / Metadata ───────────────────────────────────────────────────── */
:root {
  --theme-name: ${name};
  --theme-kind: ui;
  --theme-scheme: ${scheme};
  --theme-extends: ${scheme === "light" ? "paper" : "night"};
  --theme-version: 1;${args.author ? `\n  --theme-author: ${args.author};` : ""}
}

/* ── 令牌 / Tokens ───────────────────────────────────────────────────────── */
:root {${T.join("\n").replace(/^\n/, "\n")}
}
`;

const report = [
  ...(groundSeed && !groundHasHue && args["ground-hue"] === undefined ? [`ground ${args.ground} is achromatic — neutrals take the accent's hue; pass --ground-hue / --tint to choose`] : []),
  `accent ${args.accent.toUpperCase()} → ${accentHex}  (${contrast(accentHex, n["bg-base"]).toFixed(2)}:1 on base, target ${target})`,
  `text-primary ${contrast(n["text-primary"], n["bg-base"]).toFixed(2)}:1 · secondary ${contrast(n["text-secondary"], n["bg-base"]).toFixed(2)}:1 · muted ${contrast(n["text-muted"], n["bg-base"]).toFixed(2)}:1`,
  `neutral hue ${(((hue % 360) + 360) % 360).toFixed(0)}°, chroma ${tint.toFixed(3)}`,
];
if (args.out) { writeFileSync(args.out, css); console.error(`wrote ${args.out}`); } else process.stdout.write(css);
console.error(report.join("\n"));
