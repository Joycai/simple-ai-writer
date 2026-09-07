# 排版主题 · Typography themes

这个目录放**可以直接下载使用的排版主题**。一个主题 = 一份 `.css` 文件（+ 可选的同名文件夹装字体、纹理）。应用内置了五套排版（手稿 / 素雅 / 杂志 / 公众号 / 打字机）；这里的文件展示怎么在它们之上做自己的一套。

This folder holds **typography themes you can download and use as they are**. A theme is one `.css` file (plus an optional folder of the same name for fonts and textures). The app ships five built-in typographies (Manuscript / Clean / Magazine / WeChat / Typewriter); the files here show how to build your own on top of them.

| 文件 / file | 名字 / name | 观感 / look | 基于 / extends |
|---|---|---|---|
| [`journal.css`](journal.css) | 学报 · Journal | 章节自动编号 1 / 1.1 / 1.1.1，正文两端对齐，三线表，居中篇名，打印时标题不落单 — 报告、标书、周报、论文式长文<br>Auto-numbered sections, justified body, booktabs tables, centred title, print-safe headings — reports, bids, weeklies, papers | `clean` |

---

## 安装 / Install

1. 下载 `.css` 文件（有同名文件夹的一起下）。
   Download the `.css` (and the folder of the same name, if there is one).
2. 放进主题文件夹，二选一：
   Put it in a themes folder — either of:
   - **装机级**：设置 → 通用 → 外观 → **打开主题文件夹**。对这台机器上的所有项目生效。
     **Installation-level**: Settings → General → Appearance → **Open themes folder**. Applies to every project on this machine.
   - **项目级**：项目根目录下的 `.ai-writer/themes/`。只对这个项目生效，随仓库走；同 id 的项目级主题整份覆盖装机级的。
     **Project-level**: `.ai-writer/themes/` under the project root. That project only; travels with the repository; a project theme overrides an installation theme of the same id.
3. 设置页开着时文件夹是被监听的，卡片自己出现；否则点 **重新载入**。
   The folder is watched while Settings is open; otherwise press **Reload**.
4. 在 **排版** 一栏选中它。编辑器预览、知识库预览、导出的 HTML / PDF 一起换。
   Pick it in the **typography** row. The editor preview, knowledge-base previews and exported HTML / PDF all follow.

文件名就是主题 id（`journal.css` → `journal`）。复制一份、改个名，就是一套新主题。内置的 id（`manuscript` `clean` `magazine` `wechat` `typewriter`）是保留字，同名文件装不上。
The file name is the theme id (`journal.css` → `journal`). Copy, rename, and you have a new theme. Built-in ids (`manuscript` `clean` `magazine` `wechat` `typewriter`) are reserved; a file with one of those names cannot install.

---

## 文件长什么样 / Anatomy of a file

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

缺 `--theme-name` 是唯一「整份不可用」的情况；其它问题都是逐条丢弃：设置页的卡片会列出第几条、什么选择器、为什么，文件本身**永远不会被改写**。
A missing `--theme-name` is the one "file unusable" case; everything else is dropped rule by rule: the settings card lists the rule number, the selector and the reason, and the file on disk is **never rewritten**.

---

## 旋钮表 / The knobs

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

---

## 贡献一套 / Contribute one

一份 `.css`（有资产就加同名文件夹），文件头写清楚用途、怎么装、改哪里，在上面的表里加一行。不用改代码：主题是数据，不是分支。
One `.css` (plus a folder of the same name if it has assets), a header saying what it is for, how to install it and where to change it, and a row in the table above. No code changes: a theme is data, not a branch.

`src/lib/__tests__/themeExamples.test.ts` 会检查这个目录里的每一份：元数据齐全、`--theme-extends` 指向内置、每条选择器都在围栏里、`url()` 合规。
`src/lib/__tests__/themeExamples.test.ts` checks every file here: complete metadata, `--theme-extends` naming a built-in, every selector inside the fence, every `url()` allowed.
