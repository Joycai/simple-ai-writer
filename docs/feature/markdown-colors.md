# Markdown 配色分离（第一阶段）

> 状态：`living`。记录配色分离基础能力、莫兰迪案例及旧主题兼容边界；随实现持续更新。

界面配色、Markdown 配色、Markdown 排版是独立设置。升级默认 `follow`，保留旧行为。首个案例为内置莫兰迪内容明暗色板；无需安装文件即可选择。原莫兰迪 UI 文件继续只管理程序外观，原排版文件继续管理字号、字体与结构。

## 选择与持久化

- `app:contentMode`: `follow`（跟随界面颜色）、`auto`（独立色板，跟随应用明暗）、`light`、`dark`。
- `app:contentLight`、`app:contentDark`: 两档内容色板 ID，默认 `morandi-content-light` / `morandi-content-dark`。
- 三个键加入偏好注册表，参与备份与跨窗口刷新。主题加载、缺失标记、项目覆盖和文件刷新沿用现有流程。
- 顶栏增加二级 Markdown 配色菜单；高级色板选择在设置 → 外观。旧排版自带颜色仍显示提示。

## 数据及作用域

新增 `--theme-kind: markdown-color`，必须声明 `--theme-name` 和 `--theme-scheme`。仅接受 `contentColors.ts` 的颜色契约及六位十六进制值，拒绝 UI 变量、普通 CSS 属性、外部资源及条件规则。缺失颜色由同明暗的基础内容色板补齐。用户与项目主题均可提供内容色板；项目色板不能染色程序界面。

运行时只在 `.md-body`、AI 消息正文的 `[data-md-content]` 和预览留白的 `[data-md-surface]` 写入内容颜色。程序全局 `--color-*` 保持不变。菜单、工具栏和内容内嵌按钮继续读取 UI 令牌。源码编辑器保持 UI 配色。

旧排版对 `var(--color-*)` 的引用转为 `var(--md-legacy-color-*, 原引用)`；仅改写排版 CSS。独立配色为这些别名生成局部颜色及推导值；跟随模式不注入别名，回退到原引用（保留嵌套 fallback）。字面量颜色及 `!important` 不会被删除；旧排版的部分自定义颜色可能覆盖新色板。字体和排版参数不受内容配色控制。

内容颜色样式在排版之后安装；独立明暗模式以内容背景、文字和 `color-scheme` 同步切换。Mermaid 使用内容明暗模式。AI 消息正文有独立底色与内边距，消息按钮不在其颜色作用域内。

## 莫兰迪案例

- `themes/morandi-content-light.css`：近白背景、深褐灰正文、六色标题、暖棕引用和可读的玫瑰色链接。
- `themes/morandi-content-dark.css`：炭灰绿背景、雾豆绿、灰陶棕及对应的灰紫／青灰内容色。
- `contentColorData.ts` 为这两份示例的内置快照；测试逐值比对，防止漂移。
- 自定义时复制示例并改名，避免使用保留的内置 ID。
- `themes/morandi-garden.css` 读取专属内容颜色，并保留旧变量作为 fallback；在旧版应用上仍可使用。

## 导出与边界

HTML 和 PDF 共用导出 CSS：跟随模式保留原有行为；独立自动模式携带明暗色板；固定模式保持选定配色。HTML 画布和正文背景一起切换。PDF 自动模式在打印环境使用浅色，固定深色则保留深色样式；本阶段没有新增打印配色选项。Word 仍使用独立格式系统。本阶段未新增语法高亮引擎或色板编辑器。

## 验证

- `node node_modules/vitest/vitest.mjs run src/lib/theme/__tests__`：契约、色值快照、对比度、文件回退、命名空间及兼容引用。
- `node node_modules/vitest/vitest.mjs run --exclude '**/live.*.test.ts'`：本地前端回归，跳过需要外部服务的实时 API 探针。
- Vite 启动后打开 `/scripts/browser/content-colors.html`：使用真实主题加载器、莫兰迪排版和 ThemeMenu 检查四种明暗组合、正文内外按钮隔离、留白背景、偏好恢复、菜单键盘与窗口边界。可在宽／窄窗口重复运行，页面显示 PASS 或失败原因。

## 莫兰迪细化（2.0.1）

界面采用灰绿工作区、独立浮层和选中背景，强边框不再借用暖棕；正文保留原版纸色、文字与六级标题。深色正文是原创适配，降低代码和表头背景亮度。链接正文保留较深玫瑰色以保证可读性，下划线使用原版 `#DE7487`。原版参考：https://github.com/Kitsunee-CN/MorandiGarden/blob/main/morandigarden.css 。

新增可选 `--md-color-` 后缀：`table-border`、`heading-rule`、`hr`、`quote-bg-2`、`quote-bg-3`、`list-1` / `list-2` / `list-3`、`link-decoration`。缺失时分别回退到当前内容色板的 border、quote-bg、h3/h2/h1、link，不从界面取色，也不要求旧色板补写。嵌套引用按深度应用背景；莫兰迪表格取消斑马纹，保留现有排版的横线结构；列表使用已有嵌套容器画线，避免原版固定高度产生越界线。

字号、间距、字体、表格网格结构不随配色改变。菜单使用已有 bg-raised 浮层语义令牌，顶层与二级菜单共用；内容色板仍不能写入界面令牌。
