# Typography themes (排版主题)

A typography theme styles **rendered markdown** wherever the app shows it: the
editor's preview pane, knowledge-base entry previews, roleplay bubbles,
exported HTML and print / PDF. It is an ordinary stylesheet held inside one
fence: `.md-body`.

How it is installed matters for what you write: the app injects the built-in
base theme's CSS first (the one `--theme-extends` names), then the file as a
second `<style>` with every selector prefixed `html[data-md-theme]` — so the
file always out-specifies the base, and **you never need `!important`**.

The base rules every theme inherits — what `h2`, `blockquote`, `pre`, `table`
already look like, and which property each knob feeds — are `baseCss()` in
`src/lib/theme/markdownThemes.ts`, with the five built-ins' knob sets above it.
Read it when you need to know what you are overriding (e.g. `text-indent` is
already zeroed inside `li`, `blockquote`, `td`; quote text is `--md-color-dim`).

**Scope:** preview, knowledge-base previews, exported HTML and print / PDF.
**Not `.docx`** — Word export has its own format system (`src/lib/docx/`) and
reads no CSS, so counters, pills and fonts from a theme do not reach it. Say so
at hand-over when the user's workflow ends in Word (bids, official documents).

## The fence

| Allowed | Dropped |
|---|---|
| selectors that **start at** `.md-body` and stay inside: `.md-body h2`, `.md-body > p`, `.md-body li:nth-child(2n+1)`, `.md-body h1::after`, `.md-body:has(…)` | anything else: `body`, `h1`, `#write h1`, `.editor .md-body`; and top-level `+` / `~` (`.md-body ~ *` walks out into app chrome) |
| in a selector list, **each** comma-separated part starts at `.md-body` | `.md-body h1, h2` — the `h2` half fails |
| `:root { --theme-*: … }` metadata | any other declaration on `:root` / `html` / `body` — knobs and colours go on `.md-body` |
| `@media` `@supports` `@container` (rules inside keep the same fence), `@font-face`, `@keyframes` | `@import` `@layer` `@page` `@namespace` … |
| `url()` relative (into the folder named after the css) or `data:` | remote, absolute, or `..` paths |

## Anatomy

```css
/* header comment: what it is, how to install, how to change it — bilingual,
   see themes/phycat.css or themes/journal.css */

:root {
  --theme-name: 学报;        /* required */
  --theme-kind: markdown;    /* required */
  --theme-extends: clean;    /* the built-in whose knobs fill what you leave out */
  --theme-version: 1;
  --theme-author: …;
}

.md-body {                   /* 1. knobs — numbers first */
  --md-line: 1.9;
  --md-h1-align: center;
}

.md-body h2 { … }            /* 2. rules — only the signature touches */
```

### Pick the base by temperament

| `--theme-extends` | It already gives you |
|---|---|
| `manuscript` (the fallback) | serif, centred h1/h2, **2em first-line indent**, ornament `— · —` on `hr` — fiction |
| `clean` | sans, left-aligned, airy — reports, docs. The usual base for a ported web / Typora theme |
| `magazine` | display headings, section rules, **drop cap** |
| `wechat` | centred headings with accent bars, compact |
| `typewriter` | monospace, visible `#` markers |

A base's signature rules come along (the drop cap, the `#` markers). If you do
not want them, extend `clean` rather than fighting them.

### The knobs

The full table with defaults is in `themes/README.md` → 旋钮表. In short:
fonts (`--md-font-body/-heading/-mono`), `--md-scale` (a multiplier — **never
set `font-size` on `.md-body`**: size belongs to the surface, the preview is
17px, a lore card 15px, the picker sample 10px), `--md-line`, `--md-letter`,
`--md-para-gap`, `--md-para-indent`, heading weight / space / per-level size
and alignment, `--md-list-indent`, quote style / border / bg, the `hr` trio
(`--md-hr-line`, `--md-hr-mark` — a string drawn on the rule, `--md-hr-height`),
and the six colour aliases `--md-color-text/-dim/-faint/-accent/-surface/-border`.

Sizes inside rules are in `em` so they scale with the surface. You may declare
knobs of your own (`--phycat-radius`) on `.md-body` — prefix them with the theme
id.

## Colour: read tokens, don't write hexes

Write `var(--md-color-*)` or the app's `var(--color-*)` and the theme follows
whatever appearance is in force, light or dark, for free. A literal colour is
accepted, but the card says "自带颜色 · 不随外观变" and the theme is now wrong in
one polarity. Only write literals when the *point* of the theme is a fixed
palette (a brand template), and then set the ground too
(`.md-body { background: …; color: … }`) so text never lands on the app's
ground by accident.

Useful tokens beyond the `--md-color-*` aliases:

| Token | Use |
|---|---|
| `--color-accent-tint` · `--color-accent-tint-strong` | 12% / 23% washes of the accent — quote grounds, inline-code pills, table heads, soft shadows |
| `--color-accent-hover` | the darker (light) / lighter (dark) accent — gradient ends |
| `--color-on-accent` | text on a *filled* accent shape (a pill heading). Anything reversed must use this, never `#fff` |
| `--color-amber` · `--color-amber-soft` | the companion colour and its wash |
| `--color-bg-base` · `-surface` · `-elevated` · `--color-bg-stream` | grounds; `stream` is the code-block ground |
| `--color-border` · `-soft` · `-strong`, `--color-text-primary…ghost` | rules and text steps |
| `--shadow-sm` · `--shadow-md` | elevation that matches the appearance |

`check-theme.mjs` fails a `var(--x)` that resolves to nothing — a typo there is
otherwise an invisible bug (the declaration silently computes to `unset`).

Mapping a source's palette onto these: its link / heading colour → the accent;
its secondary decorative colour → amber; pale panel fills → `accent-tint` or
`--md-color-surface`; grey rules → `--md-color-border`. If the source's *look*
depends on specific hues, that is what the companion **appearance** file is for.

## The DOM you can target

Plain markdown-it output, no wrapper classes:

`h1`–`h6` · `p` · `strong` `em` `del` `a` `code` · `ul` `ol` `li` (nested) ·
`blockquote` (contains `p`s) · `pre > code` (no syntax-highlight spans) ·
`table > thead/tbody > tr > th/td` · `hr` · `img` (inside a `p`;
`img[data-broken]` when missing) · `.katex` / `.katex-display` (math) ·
`.mermaid` (diagrams) · `.lore-cite` (a knowledge-base citation chip — leave
its behaviour alone; colour is fine).

There is no task-list checkbox markup, no footnote section, no `[TOC]`, no
callout/admonition class — rules for those (common in Typora themes) have
nothing to match; leave them out rather than shipping dead CSS.

The base already sets `hr::before` (the ornament mark) and `blockquote`'s left
border from knobs — set `--md-quote-border: none` / `--md-hr-mark: ""` rather
than overriding the properties, so the knob table stays true for the next
author.

## Idioms that hold up

- **Decorated headings**: `position: relative` + `::before` / `::after`; for a
  bar that lines up with centred text, `width: fit-content; margin-inline: auto`
  on the heading first (see `phycat.css` h1).
- **Auto-numbered sections**: CSS counters, reset on `.md-body`
  (`journal.css`). Chinese numbering is a counter *style*, not a lookup table:
  `counter(sec, cjk-ideographic) "、"` → 一、二、… 十一、, and
  `"（" counter(sub, cjk-ideographic) "）"` → （一）. Tell the user the numbers
  are drawn by CSS, so headings must not also type them.
- **Rounded tables**: `border-collapse: separate; border-spacing: 0;
  overflow: hidden` + per-cell right / bottom borders — under `collapse` the
  borders paint over the radius.
- **Motion** only inside `@media (prefers-reduced-motion: no-preference)`; the
  static look must be complete without it.
- **Print** — the same CSS makes the PDF. Add
  `@media print { .md-body h1, … { break-after: avoid } .md-body pre, table, blockquote, img { break-inside: avoid } }`,
  and `print-color-adjust: exact` (+ `-webkit-`) on anything whose *ground*
  carries meaning (pill headings, quote bubbles, table heads), or the browser
  drops the fills.
- **System fonts by name** are fine and cost nothing: `"FangSong", "STFangsong"`,
  `"KaiTi", "STKaiti"`, `"SimHei", "PingFang SC"`… — always end the stack with
  `var(--font-serif|sans|mono)` so a machine without the face falls back to the
  user's font scheme. (A value with no `var(` makes the card say "自带字体".)
- **Own fonts**: `@font-face` with `url("<id>/file.woff2")`, the file in a
  folder named after the css next to it; it is inlined as `data:` on install
  and export. Do not commit big CJK fonts (LXGW WenKai is 25 MB) — put the
  `@font-face` block in a trailing comment with instructions, as `phycat.css`
  does, and fall back through `var(--font-serif|sans|mono)`, which follow the
  user's font scheme. A remote font URL is refused; never suggest a CDN.
- Pseudo-element `content` strings, gradients, `box-shadow`, `transform`,
  `:hover` are all fine — it is a real stylesheet inside the fence.

## The one engine trap: a `var()` shorthand followed by its longhand

The app runs on WebKit (macOS) and installs a theme by re-serialising each
rule from the CSSOM. WebKit cannot serialise a shorthand that contains `var()`
once a longhand of the same family follows it in the block:

```css
.md-body h2 {
  background: linear-gradient(110deg, var(--a), var(--b));  /* ← lost */
  background-size: 200% auto;
}
```

comes back as `background-image: ; background-color: ; …` — the ground is gone,
and a pill heading becomes reversed text on bare paper. The same happens with
`border` + `border-left`, `margin` + `margin-top`, `font` + `font-size`. Write
the longhands (`background-image` + `background-size`), or fold everything into
the one shorthand. Longhand-then-shorthand, and `border` + `border-radius`
(not the same family), are fine.

**The preview cannot show this** — the browser pane is Chromium, which
serialises it correctly. `check-theme.mjs` flags it as `✗`; the app reports it
on the theme's card as `mdShorthandLost`.

## Checking the dark render

`check-theme.mjs --preview` renders the file over a light *and* a dark
appearance. Typical dark-side failures: a literal pale fill behind token-coloured
text (unreadable), `#fff` on a filled heading, a shadow written as
`rgba(0,0,0,.1)` that vanishes (use `--shadow-sm`). If the design cannot work
in one polarity (a neon / glow language on dark, paper textures on light), make
two typography files and say in each header which band it is for — that is why
`phycat.css` and `phycat-neon.css` are separate.
