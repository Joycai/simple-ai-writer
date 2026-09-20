# Porting a Typora theme

The format here was modelled on Typora's (`theme.css` + a folder of the same
name for assets), so a port is mostly **re-rooting and subtracting**. The
worked example is the Phycat suite in `themes/` (from
`sumruler/typora-theme-phycat`); `docs/feature/theme-system-plan.md` §13 S7
records the decisions.

## Get the source

A GitHub repo: fetch the raw `.css` (often `<name>.css` plus `<name>-dark.css`,
or a `light` / `dark` pair that `@import` a shared base — follow the imports
and read them all). A local file: read it and the asset folder beside it.
**Check the licence** and carry the credit into the file header
(`--theme-author`, a line naming the repo and licence); if there is no licence,
port the *look* in your own CSS and say so, rather than copying rules verbatim.

## Split it in two

A Typora theme is one file doing two jobs. Here they are two kinds:

| In the Typora file | Becomes |
|---|---|
| `:root { --bg-color, --text-color, --primary-color, --side-bar-bg-color, --control-text-color, --active-file-bg-color, … }` — the palette | an **appearance theme** (one per palette / polarity). Feed the ground, accent and any second colour to `scripts/palette.mjs`; do not map Typora variables one-to-one — they describe Typora's chrome, not this app's 41 roles |
| `#write …` rules — headings, quotes, tables, code, lists | a **typography theme**, colours rewritten to `var(--md-color-*)` / `var(--color-*)` |
| a theme family with N colour variants over one layout | N appearance files + **one** typography file (two if the light and dark layouts genuinely differ) |

Typical palette mapping when seeding the generator:

| Typora | Seed |
|---|---|
| `--bg-color` | `--ground` |
| `--primary-color` / link / heading colour / `--element-color` | `--accent` (it will be re-computed for contrast — expected, see appearance.md) |
| a second decorative colour (gradient end, `--select-text-bg-color`'s hue) | `--companion` |
| `--side-bar-bg-color` | compare with the generated `--color-bg-surface`; adjust by hand if the source's sidebar is characteristically darker / lighter |
| panel fills (`--block-bg-color`, code / quote grounds) | nothing to seed — in the typography file they become `--md-color-surface` / `--color-accent-tint`, which the appearance derives. If the source uses *different* fills for code and quote, keep that difference with two different tokens rather than two hexes |
| `--text-color` | sanity-check against generated `--color-text-primary`; the ramp usually wins |

## Re-root the selectors

| Typora | Here |
|---|---|
| `#write` | `.md-body` |
| `#write h1`, `#write > p` | `.md-body h1`, `.md-body > p` |
| `#write blockquote`, `table`, `thead`, `tr:nth-child(2n)`, `hr`, `img`, `a`, `strong`, `em`, `del`, `code` | same tags under `.md-body` |
| `.md-fences`, `#write pre.md-fences` | `.md-body pre` (and `.md-body pre code`) |
| `#write code`, `tt` | `.md-body code` |
| `.md-image > img` | `.md-body img` |
| `mark` | not rendered here (no `==mark==`) — drop |

Every part of a selector list needs the `.md-body` start — `#write h1, #write h2`
→ `.md-body h1, .md-body h2`. Drop `!important` throughout: the installed file
already out-specifies the base.

Turn property values into knobs where a knob exists (`line-height` →
`--md-line`, heading sizes → `--md-h*-size` in `em`, paragraph margin →
`--md-para-gap`, `text-indent` → `--md-para-indent`, body `font-family` →
`--md-font-body`), and convert `px` / `rem` sizes to `em` so the theme scales
with each surface. **Do not carry over `font-size` on the root.** Each surface picks
its own size (the preview pane is 17px); `--md-scale` only nudges it. Leave it
at `1` unless the source is deliberately small or large for a reading theme
(14px body → ~`0.9`, 19px → ~`1.1`).

## Leave behind

These have nothing to match here, or are refused by the fence. Delete them
rather than porting them — dead rules cost the next author reading time.

- Typora's chrome: `#typora-sidebar`, `.sidebar-*`, `.file-list-item`,
  `.outline-*`, `#top-titlebar`, `.megamenu-*`, `footer`, `.ty-*`, `#typora-quick-open`,
  `.context-menu`, `.dropdown-menu`, `#md-searchpanel`, `.md-notification`,
  `::-webkit-scrollbar`, `::selection`, `content`, `#typora-source` /
  `.CodeMirror*` (source mode) — the *colours* they imply go to the appearance
  theme; the rules go nowhere.
- Syntax highlighting: `.cm-s-inner .cm-keyword` etc. Code blocks here are
  plain `pre > code` with no token spans.
- Markup this renderer does not emit: `.md-task-list-item` / checkboxes,
  `.md-toc`, `.footnotes` / `sup.md-footnote`, `.md-alert` / callouts,
  `.md-meta-block` (front matter), `.md-math-block` wrappers (math is `.katex` /
  `.katex-display`), `.md-diagram-panel` (diagrams are `.mermaid`), `mark`,
  `kbd` unless written as raw HTML.
- `@import` (fonts from Google / a CDN, shared base files — inline the base's
  rules instead), `@media print` page setup via `@page`, `html { font-size }`,
  `body { background }`, `:root { --anything-but-theme-meta }`.
- `@include-when-export url(…)` — Typora's export-only import. Fonts here are
  local files inlined at install; see typography.md → Own fonts.
- Background images / textures: allowed only as a relative `url()` into the
  folder named after the css, or `data:`. Small SVG textures port well as
  `data:`; a remote URL is refused.

## Keep the spirit, not the pixels

What makes a Typora theme recognisable is usually four or five gestures — how
h2 is dressed, what a quote looks like, the table head, the `hr`, the link
hover. Name those gestures first (write them in the header comment), port
those, and let the base + knobs carry the rest. Hover animations are welcome
inside `@media (prefers-reduced-motion: no-preference)`.

After porting: `check-theme.mjs` on each file, then
`--preview --with <the partner file>` and compare against the source's README
screenshots.
