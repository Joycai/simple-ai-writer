# 莫兰迪花园 · Morandi Garden

参考 [Kitsunee-CN/MorandiGarden](https://github.com/Kitsunee-CN/MorandiGarden) 的 simple-ai-writer 主题。原仓库 README 声明 MIT；这些文件是重新编写的适配，不包含原作字体或 Typora 界面代码。

An independently written adaptation of the MorandiGarden Typora theme (MIT, as declared in its README). Upstream fonts are not bundled.

| 文件 / File | 用途 / Purpose |
| --- | --- |
| `morandi-garden-light.css` | 浅色外观：灰绿分层、豆绿强调、暖棕陪衬 / Light appearance: layered grey-green, sage accent, clay companion |
| `morandi-garden-dark.css` | 深色外观：炭灰绿底、雾豆绿强调、灰陶棕陪衬 / Dark appearance: charcoal green, misty sage and muted clay |
| `morandi-garden.css` | 排版：分色标题、列表引导线、圆角引文、浅绿表格和玫瑰色链接 / Typography: coloured headings, list guides, rounded quotes, sage tables and rose links |

在应用中打开 **设置 → 外观 → 打开主题文件夹**，复制所需的外观 CSS 与排版 CSS。在外观主题的「浅色时」选择「莫兰迪花园 · 豆绿」，在「深色时」选择「莫兰迪花园 · 暮色」，在 Markdown 排版主题选择「莫兰迪花园 · 排版」。设置页开着时会自动发现文件，否则点击重新载入。

Open **Settings → Appearance → Open themes folder**, copy the desired appearance files and the typography CSS, select the appearance under **When light**, select “莫兰迪花园 · 暮色” under **When dark**, and select the typography under **Markdown Theme**. Reload if Settings was closed while copying.

## 适配取舍 / Adaptation choices

- 原作 `#FBFDFB` 纸色、`#403C3C` 正文与六色标题保留在独立内容色板中；程序界面采用 `#F3F5F1` 工作区、`#ECEFE9` 侧栏与 `#FBFDFB` 浮层，区分操作层次。
- 排版优先读取内容色板，未启用时回退界面颜色。浅色链接正文保留较深的 `#A84E64`，下划线使用原版玫瑰色 `#DE7487`，兼顾原版气质与可读性。
- 列表引导线沿嵌套列表绘制，避免原作固定像素定位在短条目和缩放时越界。标题、代码和间距都随所在预览的字号缩放。
- 字体优先使用本机已安装的阿里巴巴普惠体与 JetBrains Mono NL，缺失时回退到应用字体方案。排版作用于预览和导出的 HTML / PDF；Word 导出使用独立格式系统。

The original paper, body and six heading colours are retained in the independent content palette. The application uses layered grey-green surfaces. Typography prefers content colours and falls back to UI colours in follow mode. The light link text is darkened for readability while its decoration uses the original rose.

校验与预览 / Validate and preview:

```bash
node .claude/skills/make-theme/scripts/check-theme.mjs themes/morandi-garden-light.css
node .claude/skills/make-theme/scripts/check-theme.mjs themes/morandi-garden.css --preview --with themes/morandi-garden-light.css
```

## 排版优化 / Typography refinement

字号、字体和布局保持已有适配：较紧凑的二、三级标题、直立引用文字和轻横线表格。独立内容配色恢复原版六色标题、灰豆绿表格边线与分层列表引导线，取消默认斑马纹；嵌套引用背景逐层靠近纸面。未启用独立配色时继续使用原有回退样式。

Typography retains its compact headings, upright quotes and horizontal table rules. Independent colours restore six heading hues, sage table borders and layered list guides; nested quotes fade toward the page, and table zebra stripes are removed. Follow mode retains legacy colour fallbacks.

## 深色配色 / Dark palette

「暮色」是浅色版的深色延伸：编辑底色 `#252925`，侧栏底色 `#202420`，抬升表面 `#323832`，悬停 `#3B433B`；正文 `#E3E8E3`，雾豆绿强调 `#A5B5A0`，灰陶棕陪衬 `#C1A99A`。背景保留少量绿调，靠明度台阶区分浮层与交互状态。强调色对背景为 6.83:1，正文为 11.89:1。状态色保持语义识别；模型标签降低饱和度。独立深色内容使用更柔和的代码与表头背景，不再依赖模型标签颜色。

Dusk extends the light palette with charcoal-green grounds, a misty sage accent and muted clay. The existing typography reads theme tokens, so both appearances share one Markdown stylesheet. Menus, submenus, buttons and focus rings inherit the same core tokens; no component-specific overrides are needed.

```bash
node .claude/skills/make-theme/scripts/check-theme.mjs themes/morandi-garden-dark.css --preview --with themes/morandi-garden.css
```

## 独立内容配色

设置 → 外观 → Markdown 配色中可直接选择内置莫兰迪内容明暗色板，界面配色与文章配色可以不同。配合本排版可恢复六色标题、暖棕引用边线和独立玫瑰色链接；默认跟随模式保持旧版外观。详情见 [配色分离说明](../docs/feature/markdown-colors.md)。
