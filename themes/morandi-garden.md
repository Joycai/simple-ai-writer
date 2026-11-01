# 莫兰迪花园 · Morandi Garden

参考 [Kitsunee-CN/MorandiGarden](https://github.com/Kitsunee-CN/MorandiGarden) 的 simple-ai-writer 主题。原仓库 README 声明 MIT；这些文件是重新编写的适配，不包含原作字体或 Typora 界面代码。

An independently written adaptation of the MorandiGarden Typora theme (MIT, as declared in its README). Upstream fonts are not bundled.

| 文件 / File | 用途 / Purpose |
| --- | --- |
| `morandi-garden-light.css` | 浅色外观：近白纸、豆绿强调、暖棕陪衬 / Light appearance: near-white paper, sage accent, clay companion |
| `morandi-garden-dark.css` | 深色外观：炭灰绿底、雾豆绿强调、灰陶棕陪衬 / Dark appearance: charcoal green, misty sage and muted clay |
| `morandi-garden.css` | 排版：分色标题、列表引导线、圆角引文、浅绿表格和玫瑰色链接 / Typography: coloured headings, list guides, rounded quotes, sage tables and rose links |

在应用中打开 **设置 → 外观 → 打开主题文件夹**，复制所需的外观 CSS 与排版 CSS。在外观主题的「浅色时」选择「莫兰迪花园 · 豆绿」，在「深色时」选择「莫兰迪花园 · 暮色」，在 Markdown 排版主题选择「莫兰迪花园 · 排版」。设置页开着时会自动发现文件，否则点击重新载入。

Open **Settings → Appearance → Open themes folder**, copy the desired appearance files and the typography CSS, select the appearance under **When light**, select “莫兰迪花园 · 暮色” under **When dark**, and select the typography under **Markdown Theme**. Reload if Settings was closed while copying.

## 适配取舍 / Adaptation choices

- 原作 `#FBFDFB` 底色、`#403C3C` 正文、`#506956` 豆绿和 `#7A5F52` 暖棕保持原值；其余界面颜色使用应用生成器的明度台阶，保证悬停、按钮和焦点环可辨。暖棕浅底另做去饱和处理，使其符合原作的克制气质。
- 排版颜色全部读取应用令牌，紫、青灰与玫瑰色从语义颜色映射，因此能跟随深色外观；原作实际 CSS 的链接是玫瑰色，覆盖了其最初声明的豆绿。采用可读性更高的玫瑰色令牌。
- 列表引导线沿嵌套列表绘制，避免原作固定像素定位在短条目和缩放时越界。标题、代码和间距都随所在预览的字号缩放。
- 字体优先使用本机已安装的阿里巴巴普惠体与 JetBrains Mono NL，缺失时回退到应用字体方案。排版作用于预览和导出的 HTML / PDF；Word 导出使用独立格式系统。

The source ground, body, sage and clay colours are retained. Other shell colours follow the app's generated ramp. Typography uses app colour tokens so it also works over dark appearances; nested list borders replace fixed-position guides. Fonts fall back to the app's font scheme. Typography affects previews and HTML / PDF export; Word export uses its own format system.

校验与预览 / Validate and preview:

```bash
node .claude/skills/make-theme/scripts/check-theme.mjs themes/morandi-garden-light.css
node .claude/skills/make-theme/scripts/check-theme.mjs themes/morandi-garden.css --preview --with themes/morandi-garden-light.css
```

## 排版优化 / Typography refinement

标题保留暖棕、豆绿与柔紫，缩小二、三级标题并收紧字距，四级以下回到更克制的正文色系。引文用直立文字与浅豆绿底；代码块使用中性底色，便于区分不同内容。表格改用轻横线和淡隔行底色，嵌套列表引导线降低对比度，减少长文中的视觉干扰。所有颜色仍由应用令牌推导，适配明暗外观。

Smaller section headings and tighter tracking preserve the clay, sage and muted-purple identity while giving prose more room. Upright quotes use a sage wash; code uses a neutral surface. Light horizontal table rules, subtle alternating rows and quieter nested-list guides make dense documents easier to scan. Colours remain token-based for light and dark appearances.

## 深色配色 / Dark palette

「暮色」是浅色版的深色延伸：编辑底色 `#252925`，侧栏底色 `#202420`，抬升表面 `#323632`，悬停 `#3C403C`；正文 `#E3E8E3`，雾豆绿强调 `#A5B5A0`，灰陶棕陪衬 `#C1A99A`。背景保留少量绿调，靠明度台阶区分浮层与交互状态。强调色对背景为 6.83:1，正文为 11.89:1。状态色和模型标签沿用生成器的深色语义色，供现有排版推导灰紫标题与玫瑰色链接。

Dusk extends the light palette with charcoal-green grounds, a misty sage accent and muted clay. The existing typography reads theme tokens, so both appearances share one Markdown stylesheet. Menus, submenus, buttons and focus rings inherit the same core tokens; no component-specific overrides are needed.

```bash
node .claude/skills/make-theme/scripts/check-theme.mjs themes/morandi-garden-dark.css --preview --with themes/morandi-garden.css
```
