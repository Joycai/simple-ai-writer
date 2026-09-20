# 主题 · Themes

这个目录放**可以直接下载使用的主题**。两种：**外观主题**（应用外壳的颜色）和**排版主题**（渲染出来的文档长什么样）。一个主题 = 一份 `.css` 文件（+ 可选的同名文件夹装字体、纹理）。应用内置了六套外观（纸 / 夜 / 石 / 墨 / 霜 / 靛）和五套排版（手稿 / 素雅 / 杂志 / 公众号 / 打字机）；这里的文件展示怎么在它们之上做自己的一套。

This folder holds **themes you can download and use as they are**, of two kinds: **appearance themes** (the colours of the app shell) and **typography themes** (what a rendered document looks like). A theme is one `.css` file (plus an optional folder of the same name for fonts and textures). The app ships six built-in appearances (Paper / Night / Stone / Ink / Frost / Indigo) and five typographies (Manuscript / Clean / Magazine / WeChat / Typewriter); the files here show how to build your own on top of them.

---

## 排版主题 / Typography themes

| 文件 / file | 名字 / name | 观感 / look | 基于 / extends |
|---|---|---|---|
| [`journal.css`](journal.css) | 学报 · Journal | 章节自动编号 1 / 1.1 / 1.1.1，正文两端对齐，三线表，居中篇名，打印时标题不落单 — 报告、标书、周报、论文式长文<br>Auto-numbered sections, justified body, booktabs tables, centred title, print-safe headings — reports, bids, weeklies, papers | `clean` |
| [`phycat.css`](phycat.css) | 物理猫 · 气泡 | 居中篇名配一小段渐变横杠，二级标题是一枚药丸，三级标题左边一道圆头竖条，引文是气泡，表格圆角，虚线分隔 — 配下面任意一套**浅色**物理猫外观<br>Centred title over a gradient bar, an h2 shaped like a pill, round-capped rules beside h3, quotes as bubbles, rounded tables, a dashed rule — pair with any **light** Phycat appearance below | `clean` |
| [`phycat-neon.css`](phycat-neon.css) | 物理猫 · 灯带 | 不画框，用线和光：标题旁一条发光灯带，引文是一块玻璃，代码块只亮一道边，分隔线两头淡出 — 配下面任意一套**深色**物理猫外观<br>No boxes, just lines and light: a glowing strip beside each heading, quotes as glass, a code block lit along one edge, a rule that fades at both ends — pair with any **dark** Phycat appearance below | `clean` |

## 外观主题 / Appearance themes

一整套物理猫（Phycat）配色，八浅三深。配色取自 Typora 主题 [sumruler/typora-theme-phycat](https://github.com/sumruler/typora-theme-phycat)（MIT）：色相是原主题的，明度台阶是本应用内置主题的，强调色一路压到在自己的底上 ≥ 4.5:1 才收手——它同时当 1px 细线、填色按钮和焦点环用。

The whole Phycat set, eight light and three dark. The palettes come from the [sumruler/typora-theme-phycat](https://github.com/sumruler/typora-theme-phycat) Typora theme (MIT): the hues are the original's, the lightness ramp is this app's own built-ins', and the accent is pushed until it clears 4.5:1 on its own ground, because it doubles as a hairline, a filled button and the focus ring.

| 文件 / file | 名字 / name | 档 / band | 底与强调色 / ground and accent |
|---|---|---|---|
| [`phycat-cherry.css`](phycat-cherry.css) | 物理猫 · 樱桃红 | 浅色 / light | 淡粉纸上的樱桃红 / cherry on blush paper |
| [`phycat-caramel.css`](phycat-caramel.css) | 物理猫 · 焦糖橙 | 浅色 / light | 奶油纸上的焦糖 / caramel on cream |
| [`phycat-forest.css`](phycat-forest.css) | 物理猫 · 森绿 | 浅色 / light | 淡绿纸上的森绿 / forest on pale green |
| [`phycat-mint.css`](phycat-mint.css) | 物理猫 · 薄荷青 | 浅色 / light | 薄荷纸上的青 / teal on mint paper |
| [`phycat-sky.css`](phycat-sky.css) | 物理猫 · 天蓝 | 浅色 / light | 淡蓝纸上的天蓝 / sky on pale blue |
| [`phycat-prussian.css`](phycat-prussian.css) | 物理猫 · 普鲁士蓝 | 浅色 / light | 冷白纸上的普鲁士蓝 / Prussian on cool white |
| [`phycat-sakura.css`](phycat-sakura.css) | 物理猫 · 樱花粉 | 浅色 / light | 樱花纸上的桃红 / sakura on blush |
| [`phycat-mauve.css`](phycat-mauve.css) | 物理猫 · 淡紫 | 浅色 / light | 丁香纸上的淡紫 / mauve on lilac |
| [`phycat-vampire.css`](phycat-vampire.css) | 物理猫 · 吸血鬼 | 深色 / dark | 石板灰底上的血红与紫 / red and violet on slate |
| [`phycat-radiation.css`](phycat-radiation.css) | 物理猫 · 辐射 | 深色 / dark | 暗岩绿底上的生化绿与琥珀 / mint neon and amber on dark rock |
| [`phycat-abyss.css`](phycat-abyss.css) | 物理猫 · 深渊 | 深色 / dark | 午夜蓝底上的电光青 / electric cyan on midnight blue |

配套关系不是硬绑定：`phycat.css` / `phycat-neon.css` 里一个颜色都没有写死，全部读 `var(--color-*)`，所以它们配内置外观也成立，物理猫外观配内置排版也成立。
The pairing is not a binding: neither typography theme writes a literal colour — every value reads `var(--color-*)` — so they work over a built-in appearance too, and a Phycat appearance works under a built-in typography.

---

## 安装 / Install

1. 下载 `.css` 文件（有同名文件夹的一起下）。
   Download the `.css` (and the folder of the same name, if there is one).
2. 放进主题文件夹：
   Put it in a themes folder:
   - **装机级**：设置 → 通用 → 外观 → **打开主题文件夹**。对这台机器上的所有项目生效。**外观主题只能放这里。**
     **Installation-level**: Settings → General → Appearance → **Open themes folder**. Applies to every project on this machine. **Appearance themes go here only.**
   - **项目级**：项目根目录下的 `.ai-writer/themes/`，**只收排版主题**。只对这个项目生效，随仓库走；同 id 的项目级主题整份覆盖装机级的。
     **Project-level**: `.ai-writer/themes/` under the project root, **typography themes only**. That project only; travels with the repository; a project theme overrides an installation theme of the same id.

   为什么外观主题不进项目：克隆一个仓库就等于打开它，项目里的样式表会跟着装上。排版主题只作用在渲染出来的文档里，外观主题改的是整个外壳——那不是一份陌生仓库该有的权限。
   Why an appearance theme may not live in a project: opening a cloned repository installs its stylesheets. A typography theme only touches the rendered document; an appearance theme repaints the whole shell, and that is not a stranger's repository's call.
3. 设置页开着时文件夹是被监听的，卡片自己出现；否则点 **重新载入**。
   The folder is watched while Settings is open; otherwise press **Reload**.
4. 选中它：外观主题在 **外观主题** 一栏（分「浅色时」「深色时」两档，各选一套）；排版主题在 **Markdown 排版主题** 一栏，编辑器预览、知识库预览、导出的 HTML / PDF 一起换。
   Pick it: an appearance theme in the **Appearance themes** row (two bands, "When light" and "When dark", one each); a typography theme in the **Markdown Theme** row, where the editor preview, knowledge-base previews and exported HTML / PDF all follow.

文件名就是主题 id（`journal.css` → `journal`）。复制一份、改个名，就是一套新主题。内置的 id 是保留字，同名文件装不上：外观 `paper` `night` `stone` `ink` `frost` `indigo`，排版 `manuscript` `clean` `magazine` `wechat` `typewriter`。
The file name is the theme id (`journal.css` → `journal`). Copy, rename, and you have a new theme. Built-in ids are reserved and a file with one of those names cannot install: `paper` `night` `stone` `ink` `frost` `indigo` for appearances, `manuscript` `clean` `magazine` `wechat` `typewriter` for typographies.

---

## 文件长什么样 / Anatomy of a file

两种文件的头一样，`--theme-kind` 决定后面按哪套规则读。
Both kinds open the same way; `--theme-kind` decides which set of rules the rest is read under.

**排版主题 / a typography theme**

```css
/* 1. 元数据：只有 --theme-* 可以写在 :root 里 / metadata: only --theme-* lines belong on :root */
:root {
  --theme-name: 学报;          /* 必填 · 网格里显示的名字 / required · the name the grid shows */
  --theme-kind: markdown;      /* 必填 · 排版主题 / required · a typography theme */
  --theme-extends: clean;      /* 没写到的旋钮从这套内置取，缺省 manuscript / knobs left out come from this built-in; default manuscript */
  --theme-version: 1;          /* 可选 / optional */
  --theme-author: 某某;        /* 可选 / optional */
}

/* 2. 旋钮：改数字 / knobs: change numbers */
.md-body {
  --md-line: 1.9;
  --md-h1-align: center;
}

/* 3. 规则：每条选择器都从 .md-body 开始 / rules: every selector starts at .md-body */
.md-body h2 { border-bottom: 1px solid var(--md-color-border); }
```

**外观主题 / an appearance theme**

```css
/* 1. 元数据 / metadata */
:root {
  --theme-name: 物理猫 · 薄荷青;  /* 必填 / required */
  --theme-kind: ui;               /* 必填 · 外观主题 / required · an appearance theme */
  --theme-scheme: light;          /* 必填 · light | dark，归哪一档 / required · which band */
  --theme-extends: paper;         /* 同一档的内置基底：light→paper，dark→night / the same-polarity built-in */
}

/* 2. 令牌：只有令牌，没有选择器也没有普通属性 / tokens: nothing but tokens */
:root {
  --color-bg-base: #E5F5F6;
  --color-sienna:  #007981;
  /* …剩下 39 个 / …and the other 39 */
}
```

缺 `--theme-name`（外观主题还要 `--theme-scheme`）是唯一「整份不可用」的情况；其它问题都是逐条丢弃：设置页的卡片会列出第几条、什么选择器、为什么，文件本身**永远不会被改写**。
A missing `--theme-name` — plus `--theme-scheme` for an appearance theme — is the one "file unusable" case; everything else is dropped rule by rule: the settings card lists the rule number, the selector and the reason, and the file on disk is **never rewritten**.

---

## 排版主题的旋钮表 / A typography theme's knobs

每个 `--md-*` 都有默认值，写在 `.md-body { … }` 里覆盖。内置主题自己也只是一组这样的旋钮加几条规则。
Every `--md-*` has a default; override it inside `.md-body { … }`. The built-in themes are nothing more than a set of these knobs plus a few rules.

| 旋钮 / knob | 默认 / default | 作用 / what it does |
|---|---|---|
| `--md-font-body` | `var(--font-serif)` | 正文字体 / body font |
| `--md-font-heading` | `var(--md-font-body)` | 标题字体 / heading font |
| `--md-font-mono` | `var(--font-mono)` | 代码字体 / code font |
| `--md-scale` | `1` | 字号倍率。字号本身（`--md-size`）归界面管：预览、知识库、样张各有各的，主题只能按比例缩放 / size multiplier. The size itself belongs to the surface; a theme only scales it |
| `--md-line` | `1.78` | 行距 / line height |
| `--md-letter` | `normal` | 字距 / letter spacing |
| `--md-para-gap` | `1.1em` | 段距 / paragraph gap |
| `--md-para-indent` | `0` | 段首缩进（手稿是 `2em`）/ first-line indent (Manuscript uses `2em`) |
| `--md-h-weight` | `500` | 标题字重 / heading weight |
| `--md-h-space-top` · `--md-h-space-bottom` | `1.5em` · `0.5em` | 标题上下留白 / space around headings |
| `--md-h1-size` · `--md-h1-weight` · `--md-h1-letter` · `--md-h1-align` | `2.2em` · 同标题字重 · `-0.01em` · `left` | 一级标题 / h1 |
| `--md-h2-size` · `--md-h2-align` | `1.55em` · `left` | 二级标题 / h2 |
| `--md-h3-size` · `--md-h4-size` | `1.2em` · `1.05em` | 三、四级标题 / h3, h4 |
| `--md-list-indent` | `1.8em` | 列表缩进 / list indent |
| `--md-quote-style` · `--md-quote-border` · `--md-quote-bg` | `italic` · `2px solid var(--md-color-accent)` · `transparent` | 引文的字形、左边线、底色 / quote style, left rule, ground |
| `--md-hr-line` · `--md-hr-mark` · `--md-hr-height` | `1px solid var(--md-color-border)` · `""` · `auto` | 分隔线；`--md-hr-mark` 是画在线上的装饰字符（手稿是 `"— · —"`）/ rules; the mark is an ornament drawn on the rule |
| `--md-color-text` · `--md-color-dim` · `--md-color-faint` | 跟外观 / follow the appearance | 正文、次级、最淡的文字 / body, secondary, faintest text |
| `--md-color-accent` | `var(--color-sienna)` | 强调色：链接、行内代码、引文边线 / accent: links, inline code, quote rule |
| `--md-color-surface` · `--md-color-border` | 跟外观 / follow the appearance | 代码块和表头的底、边线 / code and table-head ground, rules |

**颜色 / Colours.** 写 `var(--md-color-*)` 或应用的 `var(--color-*)` 令牌（`--color-bg-base` `--color-bg-elevated` `--color-border` `--color-border-soft` `--color-text-primary` `--color-text-secondary` `--color-text-faint` `--color-sienna` `--color-amber` `--color-amber-soft` `--color-accent-tint` …），主题就跟着浅色 / 深色外观走。写死的色值也接受，卡片会标「自带颜色 · 不随外观变」。
Write `var(--md-color-*)` or the app's `var(--color-*)` tokens and the theme follows the light / dark appearance. Literal colours are accepted; the card marks the theme "own colours · does not follow the appearance".

**字体 / Fonts.** `var(--font-serif)` / `var(--font-sans)` / `var(--font-mono)` 跟着设置里的字体方案走。要带自己的字体：`@font-face` + 相对路径 `url("journal/x.woff2")`，文件放在与 css 同名的文件夹里，安装和导出时内联进样式表。
The `--font-*` stacks follow the font scheme in Settings. To bring your own: `@font-face` with a relative `url("journal/x.woff2")`, the file inside the folder named after the css; it is inlined on install and export.

---

## 外观主题写什么 / What an appearance theme writes

**41 个核心令牌，一个不多。** 应用把界面颜色分成三层：刻度（间距、圆角、字体——不归主题管）、**核心**（这 41 个）、推导（另外两百多个，由核心按公式 `color-mix` 推出来）。所以写完这 41 个，整个应用就换完了；改一个 `--color-sienna`，强调色在每一处跟着走。内置的「石」「墨」「霜」「靛」也正是只写了这 41 个。

**41 core tokens, and nothing else.** The app's colours come in three tiers: scales (spacing, corners, type — not a theme's), the **core** (these 41), and derived (two hundred-odd more, `color-mix`ed out of the core). Write the 41 and the whole app is retinted; move `--color-sienna` and the accent follows everywhere. The built-in Stone / Ink / Frost / Indigo write exactly these 41 too.

| 组 / group | 令牌 / tokens |
|---|---|
| 底 / grounds | `--color-bg-base` `--color-bg-surface` `--color-bg-elevated` `--color-bg-hover` `--color-bg-tinted` `--color-bg-overlay` |
| 文字 / text | `--color-text-primary` `--color-text-secondary` `--color-text-muted` `--color-text-faint` `--color-text-ghost` |
| 强调 / accent | `--color-sienna` `--color-sienna-hover` `--color-amber` `--color-amber-soft` |
| 线 / rules | `--color-border` `--color-border-soft` `--color-border-strong` |
| 状态 / status | `--color-success` `--color-warning` `--color-error` |
| 模型能力标签 / model-type tags | `--color-type-{text,multimodal,image,video,vision,asr}-{bg,fg}` |
| 投影与毛玻璃 / elevation and glass | `--shadow-sm` `--shadow-md` `--shadow-lg` `--shadow-xl` `--shadow-drawer` `--glass-bg` `--glass-bg-strong` `--glass-border` |

名字里的 `sienna`（赭石）和 `amber`（琥珀）是内置「纸」主题留下的词，读作「唯一强调色」和「第二色」——它们不必是褐色和琥珀色。
The names `sienna` and `amber` are the built-in Paper theme's words; read them as "the one accent" and "the companion" — they need not be brown and amber.

**别从这张表开始。** 设置 → 通用 → 外观 → **把当前主题导出为文件**，得到的就是一份每个令牌带角色注释的完整 CSS：改几行、改个名、放回文件夹。
**Don't start from this table.** Settings → General → Appearance → **Export current theme as file** writes a complete CSS with every token annotated with its role: change a few lines, change the name, put it back in the folder.

**一个数字要自己盯：** `--color-sienna` 同时当 1px 细线、填色按钮和焦点环用，在 `--color-bg-base` 上低于 4.5:1 就有一样东西看不清。这个目录里的样例都过了这条线，`themeExamples.test.ts` 也在盯着。
**One number to watch:** `--color-sienna` doubles as a hairline, a filled button and the focus ring — under 4.5:1 on `--color-bg-base`, one of the three stops reading. Every sample here clears it, and `themeExamples.test.ts` keeps them there.

---

## 围栏 / The fence

排版主题是一份**只作用于渲染出来的文档**的样式表。校验器用浏览器自己的解析器读文件，逐条检查：
A typography theme is a stylesheet that **only touches the rendered document**. The validator reads the file with the browser's own parser and checks rule by rule:

| 可以 / allowed | 不可以 / refused |
|---|---|
| 选择器从 `.md-body` 开始：`.md-body h2`、`.md-body > p`、`.md-body li:nth-child(2n+1)`<br>selectors that start at `.md-body` | 不从它开始的：`body`、`h1`、`.editor .md-body`<br>anything that does not start there |
| 后代与 `>` / descendant and child combinators | 顶层的 `+` / `~`（`.md-body ~ *` 选中的是应用界面）<br>top-level `+` / `~` — they walk out into the app's own chrome |
| `:root` 里的 `--theme-*` 元数据 / `--theme-*` metadata on `:root` | `:root` / `html` / `body` 上的其它声明——颜色写进 `.md-body`<br>any other declaration there — colours go on `.md-body` |
| `@media` `@supports` `@container`（里面的规则守同一条围栏）、`@font-face`、`@keyframes` | 其它 at-rule：`@import` `@layer` `@page` … |
| `url()` 相对路径或 `data:` / relative or `data:` | 远程、绝对路径、`..` 向上走的 `url()`<br>remote, absolute, or `..` paths |

外观主题的围栏更窄：它**不是样式表，是一组令牌**。
An appearance theme's fence is narrower still: it **is not a stylesheet, it is a set of tokens**.

| 可以 / allowed | 不可以 / refused |
|---|---|
| `:root { … }`（或 `[data-theme="<id>"]`，但改文件名就失配了，推荐 `:root`）<br>`:root { … }` — or `[data-theme="<id>"]`, which stops matching if you rename the file | 别的选择器：`body`、`.sidebar`、`:root .x`<br>any other selector |
| 核心与推导层的令牌名 / core and derived token names | 刻度令牌（`--radius-*` `--font-size-*` `--space-*` …）：布局与字号不由外观主题决定<br>scale tokens — layout and type size are not a theme's to set |
| — | 普通 CSS 属性（`background: …`）／应用不认识的令牌名<br>plain properties, and token names the app does not declare |
| — | 任何 at-rule，`@media (prefers-color-scheme)` 也包括在内：明暗是 `--theme-scheme` 说了算，不是系统<br>any at-rule, `@media (prefers-color-scheme)` included — the polarity is `--theme-scheme`'s call, not the OS's |

---

## 贡献一套 / Contribute one

一份 `.css`（有资产就加同名文件夹），文件头写清楚用途、怎么装、改哪里，在上面对应的表里加一行。不用改代码：主题是数据，不是分支。
One `.css` (plus a folder of the same name if it has assets), a header saying what it is for, how to install it and where to change it, and a row in the matching table above. No code changes: a theme is data, not a branch.

`src/lib/theme/__tests__/themeExamples.test.ts` 会检查这个目录里的每一份，按 `--theme-kind` 分两路：排版主题看元数据齐全、`--theme-extends` 指向内置、每条选择器都在围栏里、`url()` 合规；外观主题看元数据齐全、令牌名都在契约里、41 个核心一个不缺，以及强调色和正文色在自己的底上够不够。
`src/lib/theme/__tests__/themeExamples.test.ts` checks every file here, branching on `--theme-kind`: a typography theme for complete metadata, a built-in base, every selector inside the fence and every `url()` allowed; an appearance theme for complete metadata, token names the contract knows, all 41 core tokens present, and enough contrast for its accent and its body text over its own ground.

---

## 出处 / Credits

`phycat-*` 的配色取自 [sumruler/typora-theme-phycat](https://github.com/sumruler/typora-theme-phycat)（MIT），`phycat.css` / `phycat-neon.css` 的排版语言同源。原主题用的是霞鹜文楷（LXGW WenKai）；字体不随主题分发，`phycat.css` 文件末尾有自带字体的写法。
The `phycat-*` palettes, and the typography language of `phycat.css` / `phycat-neon.css`, come from [sumruler/typora-theme-phycat](https://github.com/sumruler/typora-theme-phycat) (MIT). The original sets LXGW WenKai; the font is not shipped with the theme, and the tail of `phycat.css` shows how to bring your own.
