# 莫兰迪花园 · Morandi Garden

参考 [Kitsunee-CN/MorandiGarden](https://github.com/Kitsunee-CN/MorandiGarden) 的 simple-ai-writer 主题。原仓库 README 声明 MIT；这些文件是重新编写的适配，不包含原作字体或 Typora 界面代码。

An independently written adaptation of the MorandiGarden Typora theme (MIT, as declared in its README). Upstream fonts are not bundled.

| 文件 / File | 用途 / Purpose |
| --- | --- |
| `morandi-garden-light.css` | 浅色外观：近白纸、豆绿强调、暖棕陪衬 / Light appearance: near-white paper, sage accent, clay companion |
| `morandi-garden.css` | 排版：分色标题、列表引导线、圆角引文、浅绿表格和玫瑰色链接 / Typography: coloured headings, list guides, rounded quotes, sage tables and rose links |

在应用中打开 **设置 → 外观 → 打开主题文件夹**，复制两份 CSS。在外观主题的「浅色时」选择「莫兰迪花园 · 豆绿」，在 Markdown 排版主题选择「莫兰迪花园 · 排版」。设置页开着时会自动发现文件，否则点击重新载入。

Open **Settings → Appearance → Open themes folder**, copy both CSS files, select the appearance under **When light**, and select the typography under **Markdown Theme**. Reload if Settings was closed while copying.

## 适配取舍 / Adaptation choices

- 原作 `#FBFDFB` 底色、`#403C3C` 正文、`#506956` 豆绿和 `#7A5F52` 暖棕保持原值；其余界面颜色使用应用生成器的明度台阶，保证悬停、按钮和焦点环可辨。暖棕浅底另做去饱和处理，使其符合原作的克制气质。
- 排版颜色全部读取应用令牌，紫、青灰与玫瑰色从语义颜色映射，因此能跟随深色外观；原作实际 CSS 的链接是玫瑰色，覆盖了其最初声明的豆绿。采用可读性更高的玫瑰色令牌。
- 列表引导线沿嵌套列表绘制，避免原作固定像素定位在短条目和缩放时越界。标题、代码和间距都随所在预览的字号缩放。
- 字体优先使用本机已安装的阿里巴巴普惠体与 JetBrains Mono NL，缺失时回退到应用字体方案。排版作用于预览和导出的 HTML / PDF；Word 导出使用独立格式系统。

The source ground, body, sage and clay colours are retained. Other shell colours follow the app's generated ramp. Typography uses app colour tokens so it also works over dark appearances; nested list borders replace fixed-position guides. Fonts fall back to the app's font scheme. Typography affects previews and HTML / PDF export; Word export uses its own format system.

校验与预览 / Validate and preview:

```bash
node .claude/skills/make-theme/scripts/check-theme.mjs theme/morandi-garden-light.css
node .claude/skills/make-theme/scripts/check-theme.mjs theme/morandi-garden.css --preview --with theme/morandi-garden-light.css
```
