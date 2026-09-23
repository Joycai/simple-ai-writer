---
name: make-theme
description: Make a theme file for this app (simple-ai-writer) from a text description, a screenshot / image, or an existing Typora theme — either an appearance theme (外观主题 — the app shell's colours, 41 core tokens on :root) or a markdown typography theme (排版主题 — how the rendered document looks, CSS fenced to .md-body), or a matching pair. Use this whenever the user wants a new theme, colour scheme, skin, palette, dark/light variant, or markdown/preview/export style for the app — "做一套主题", "按这张截图配色", "把这个 Typora 主题搬过来", "port this Typora theme", "给预览换个排版", "来一套 Nord / Dracula / Solarized", "往 themes/ 里加一套样例" — and also when a theme file installs with a problems card, loses rules, or looks wrong. Prefer it over writing theme CSS by hand - the format has two fences the app enforces silently, and the skill ships a palette generator, a checker built on the app's own validator, and a preview renderer.
---

# make-theme

A theme in this app is **one `.css` file**. There are two kinds and they are
read under different rules, so the first decision is which one (or both) the
request is asking for.

| | 外观主题 appearance (`--theme-kind: ui`) | 排版主题 typography (`--theme-kind: markdown`) |
|---|---|---|
| Changes | the whole app shell: grounds, text, accent, borders, shadows | the rendered document only: preview pane, knowledge-base previews, exported HTML / PDF |
| Is | **a set of tokens** — `:root { --color-…: … }`, nothing else | **a stylesheet** — knobs (`--md-*`) plus rules, every selector starting at `.md-body` |
| One file covers | one polarity (`--theme-scheme: light` *or* `dark`) | both polarities, *if* it writes no literal colour |
| Installs in | the installation folder only | the installation folder, or a project's `.ai-writer/themes/` |
| Details | [references/appearance.md](references/appearance.md) | [references/typography.md](references/typography.md) |

Read the reference for the kind you are making before writing; read
[references/typora.md](references/typora.md) as well when the source is a Typora
theme. `themes/README.md` at the repo root is the author-facing guide (knob
table, token table, both fences) and the shipped files beside it —
`phycat-mint.css`, `phycat-abyss.css`, `phycat.css`, `phycat-neon.css`,
`journal.css` — are the house style to imitate.

## Which kind does the request want?

- "配色 / 颜色 / 深色模式 / 像 Nord 那样 / 应用看起来…" → appearance. A named
  scheme with light and dark halves (Solarized, Catppuccin, GitHub) is **two
  files**, `<id>-light.css` and `<id>-dark.css` — the app has a "when light" and
  a "when dark" band and picks one for each.
- "标题样式 / 引用块 / 行距 / 首行缩进 / 导出的 PDF 长这样 / 公文格式" → typography.
- A Typora theme, or a screenshot of a *document*, usually carries both: a
  palette and a typographic language. Make **one typography file that writes no
  literal colour plus one appearance file per palette**. That split is the point
  of the design — colour is the appearance theme's job, so the same typography
  follows any appearance and flips with dark mode for free. Eleven Phycat
  colours ship as eleven appearance files and two typography files, not eleven
  pairs.
- A screenshot of an *app window* (editor, sidebar) is an appearance request;
  only make typography if the rendered document in it has a distinctive look.

If it is genuinely unclear, say which you chose and why rather than asking —
the second file is cheap to add later.

## Where does the file go?

Ask yourself what the user is doing, because the destinations carry different
obligations:

- **For their own use** → write it where they say; otherwise the installation
  folder (macOS: `~/Library/Application Support/com.simple-ai-writer.app/themes/`;
  in-app: 设置 → 外观 → 打开主题文件夹). A typography theme meant for
  one project goes in that project's `.ai-writer/themes/`. Appearance themes
  are refused there on purpose (a cloned repo must not repaint the shell).
- **To ship with the repo** ("加到 themes/", "做成样例") → `themes/<id>.css`, and
  then `themeExamples.test.ts` holds it to more than the format does: a row in
  `themes/README.md`'s matching table (the test greps for `` `<file>` ``), the
  **whole** 41-token core for an appearance theme, accent ≥ 4.5:1 and body text
  ≥ 7:1 over its own ground, `--theme-extends` written out. Also bump the file
  counts in prose ("Fourteen files today" in `docs/reference/codemap.md`, the
  list in `docs/reference/design-system.md`, the root `README.md`), and record
  the *why* of any non-obvious choice in `docs/feature/theme-system-plan.md` §13
  the way S7 does — this repo keeps decisions in docs, not commit messages. If
  the palette comes from someone else's work, credit it and its licence in the
  file header and in `themes/README.md` → 出处.

The file name **is** the theme id: lowercase letters, digits, hyphens.
Built-in ids are reserved and will not install — `paper night stone ink frost
indigo` (appearance), `manuscript clean magazine wechat typewriter`
(typography).

## Workflow

### 1. Extract the design from the source

- **Description** — turn adjectives into decisions before touching CSS: which
  polarity, the ground's hue and how tinted it is, the one accent, a companion
  colour; for typography: serif or sans, aligned how, dense or airy, what the
  headings / quotes / rules / tables do. State the decisions in a sentence or
  two so the user can correct the reading.
- **Screenshot / image** — look at it (Read the file) and *sample*, don't guess
  hexes from memory of "what that theme usually is": name the ground, the
  surface (sidebar / cards), body text, the accent (links, buttons, the active
  item), a second colour if one exists. A screenshot's colours are approximate
  (compression, antialiasing), which is fine — the ramp comes from the generator
  anyway; what you need from the image is *hues and relationships*. For
  typography read structure: heading alignment and decoration, quote treatment,
  code block shape, table style, spacing rhythm.
- **Typora theme** — read the CSS (fetch the repo or the file the user gives).
  Its `:root` variables are the palette; its `#write …` rules are the
  typography. [references/typora.md](references/typora.md) has the mapping and
  the parts to leave behind.

### 2. Appearance: generate, then tune

Do not hand-pick 41 colours. Run the generator — it keeps the lightness ramp of
the built-in Stone / Ink (already tuned against every surface of the app),
swaps in your hue and chroma, and pushes the accent until it actually reads:

```bash
node .claude/skills/make-theme/scripts/palette.mjs --scheme light \
  --accent "#00A3AD" --ground "#E5F5F6" --name "薄荷" --id mint --out <dest>/mint.css
# --help lists every flag. --ground-hue / --tint steer the neutrals and combine with --ground:
#   a white or grey ground has no hue, so say which way the greys lean (--ground "#ffffff" --ground-hue 250 --tint 0.006)
```

Then read the output and tune by hand what the source actually specifies (a
second colour, a status red that belongs to the scheme), and replace the two
`TODO` lines in the header with what the theme is and where its colours came
from. The generator's report line shows when it moved the accent; if it moved
it a lot, tell the user — "your #FF79C6 became #C2388A on a light ground
because it is also the 1px rule and the focus ring" is information they want.
The reasoning behind each token group is in
[references/appearance.md](references/appearance.md).

### 3. Typography: knobs first, rules second

Start from the built-in base closest to the target (`--theme-extends`), set
`--md-*` knobs for everything a knob can express, and write rules only for the
signature touches. Colours come from `var(--md-color-*)` / `var(--color-*)`;
a literal colour pins the theme to one polarity. Details, the DOM you can
target, and idioms that survive export and print:
[references/typography.md](references/typography.md).

### 4. Check — every time, before showing the user

```bash
node .claude/skills/make-theme/scripts/check-theme.mjs <file.css>
```

Run from the repo root. It feeds each selector, `url()` and token name to the
**app's own validator predicates**, so `✗` lines are rules the app would drop
(silently, apart from a card in Settings), plus a contrast table for appearance
themes and dangling-`var()` / literal-colour findings for typography themes.
Fix every `✗`; treat each `!` as a decision to make, not noise. The app never
rewrites a bad file and never refuses the whole thing — it just quietly loses
rules — which is exactly why this step is not optional.

### 5. Look at it

```bash
node .claude/skills/make-theme/scripts/check-theme.mjs <file.css> --preview [--with <partner.css>]
```

This writes `previews.local/<id>.<scheme>.html` (gitignored): a mock of the app
shell — sidebar rows in rest / hover / active, buttons, focus ring, tags,
shadows — around a full sample document, with the palette resolved by the app's
own `exportPaletteCss`, so the ~200 derived tokens are the real formulas.
A typography theme renders twice, over a light and a dark appearance;
`--with` names the partner file to pair it with, and repeats — give a light
and a dark appearance and each render uses its own (otherwise the built-in
Paper / Night fills the missing band).

Open it in the browser pane: `preview_start` the `simple-ai-writer-worktree-vite`
launch config, then **in one batch** `navigate` to
`http://localhost:1425/previews.local/<id>.<scheme>.html` → `resize_window`
1280×800 → `screenshot`. The page scrolls as a whole, and `#quote` `#lists`
`#code` `#table` on the URL jump to those parts of the sample — the first
screen shows only the title and a heading, and tables and quotes are where
themes break. When the source was a screenshot, compare the two
side by side and iterate; when it was a description, check it *feels* like the
words. Look specifically at: hover row vs. resting row (is the step visible?),
the accent as a 1px line, text on the filled button, muted text, and — for
typography — the dark render (anything unreadable there is a literal colour or
a `--color-on-accent` misuse). The real app cannot be driven by GUI automation
and `pnpm dev` in a browser has no theme folder, so this preview *is* the
visual check; for the final word, tell the user to drop the file in the themes
folder with Settings open — the card appears by itself.

### 6. Hand over

Say which files you wrote and where, how to install (or that it is already in
the folder), what the source gave you versus what you decided, and anything the
checker still flags with a reason for leaving it. If the file went into
`themes/`, run `pnpm test themeExamples` and do the README / docs steps above.
