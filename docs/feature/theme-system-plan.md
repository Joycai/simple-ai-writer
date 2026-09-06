# 主题系统 —— 令牌化的外观主题 + 插件式的 Markdown 排版主题

> 状态：`shipped`。2026-09-06 起草，同日对着 `main` 3f16add（v1.48.0）复核；**S1–S4 全部落地**（§13 记实现与方案的出入）。设计稿 `05i 主题 Themes` 已回，它怎么答的与对方案的两处改动记在 [`theme-system-ui-brief.md`](theme-system-ui-brief.md) 文首——其中「元数据改成 `--theme-*` 自定义属性」已采纳进 §5。
>
> 本文是**设计**，不是现状记录：§1 是从代码里读出来的今天，§3 起是要做成的样子。落地后把出入记回本文末尾，视觉口径再收进 `docs/reference/design-system.md` → Theming。

## 0. 一句话

今天应用已经是「全部 UI 只读令牌」的（`tokens.css` 一个 `:root` + 两个 `[data-theme]` 块，每块 214 个自定义属性），Markdown 排版也已经是「一个生成器、五套 `--md-*`」的。缺的不是令牌化，是**边界**：主题写死在两个 CSS 块和一个 TS 数组里，作者装不进第三套。本方案把这两样东西各自变成**文件**——外观主题是一份只声明令牌的 CSS，排版主题是一份只作用于 `.md-body` 的 CSS（Typora 的 `#write` 约定）——放进装机级的 `themes/` 目录，应用扫描、校验、安装，并把它们喂进导出。任何一份主题文件都可以只有十二行：它永远叠在一套内置基底之上。

## 1. 现状盘点（2026-09-06 读代码所得）

| 事实 | 位置 | 对本方案的意义 |
|---|---|---|
| 三根独立的切换轴：`data-theme`（light / dark）、`data-font`（四组中西字体）、`data-md-theme`（五套排版） | `appStore.ts` 的三个 `apply*`，都写在 `<html>` 上 | 轴的划分是对的，保留；要改的是每根轴的**取值域**从枚举变成注册表 |
| `tokens.css` = `:root` 55 个刻度令牌 + 每个主题 214 个 | `src/styles/tokens.css` | 214 里 98 个是语义层（`--color-*` 88、`--shadow-*` 6、`--glass-*` 4），**116 个是面向单个界面的手调色**（`--lore` 37 / `--stg` 35 / `--sync` 20 / `--rp` 16 / `--snip` 6 / `--writer` 2）。让作者手填 214 个值是主题文件走不通的第一道墙。这个数还在涨：本周 03f / 05h 两张设计稿落地又加了 6 个 |
| 三个 PR（e2e1588 / 0d6f8d8 / bb5c217）修的都是同一类 bug：CSS 里引用了**不存在的令牌**（`--color-danger`、`--color-red`、`--color-text`），`var()` 静默退成 `initial`，没有任何测试抓它 | `git log` 2026-09-05/06 | 契约清单一旦成为常量，「每个 `var(--x)` 都必须解析到清单里」就是一条一行的守卫（§12）；这条守卫的价值不等主题文件，S1 就该有 |
| 主题奇偶校验测试：一个令牌要么在 `:root`，要么两个主题**都**定义 | `src/lib/__tests__/themeTokenParity.test.ts` | 它守的是「内置主题必须完整」；将来演化成**契约测试**，第三方主题不受它约束（见 §4） |
| 深浅切换走 View Transition 交叉淡化；`system` 模式挂 `matchMedia` 监听 | `appStore.ts` `applyThemeAnimated` | 保留原样；主题切换复用同一条路 |
| Markdown 排版是 **CSS-in-TS 生成器**：`baseCss` 全部写成 `--md-*`，五个主题只是变量包 + 可选 `rules`；同一份文本进 `<style id="md-themes">` 和导出的 HTML | `src/lib/theme/markdownThemes.ts` | 这个「一个生成器喂两处」的结构是方案的核心资产，不能丢；用户主题必须也能进导出 |
| 生成器额外发一遍 `.md-body[data-md-theme=x]` 的**钉住**块，给设置页的样张用 | 同上 `markdownThemesCss()` | 用户主题无法这样钉住（没有解析器给它加前缀）；样张改成沙箱 iframe 之后这个机制退役（§7.3） |
| 导出的 HTML 自带 `EXPORT_TOKEN_CSS`——**手抄的一份浅色调色板** | 同上，`export.ts` 拼进 `<style>` | 这是应用里唯一一份会漂移的令牌副本；导出应从注册表生成（§9） |
| 编辑器语法高亮用 `defaultHighlightStyle`（浅色写死），只有 heading / emphasis / link 被模块 CSS 改成令牌 | `CodeEditor.tsx:185`, `CodeEditor.module.css` `.tok-*` | 主题盲区之一：代码、引用等 token 在夜间是浅色配色 |
| Mermaid 按 `data-theme === "light"` 二选一，`securityLevel: "strict"` | `Preview.tsx:151` | 只认字面 `light`；主题 id 可变之后这里必须读**明暗**而不是主题名 |
| 模块 CSS 里 `data-theme` 只出现 2 处，硬编码色值 36 处（多数是 `#fff` 和遮罩） | `grep` | 迁移面很小，值得一次收干净 |
| 设置页整体做了一次 `--color-* → --stg-*` 的重映射 | `SettingsPage.module.css` `.page` | 主题样张放在设置页里会被这次重映射染色——样张必须隔离（§7.3） |
| 偏好存 `config.db`（`PREF_KEYS`），主题是**装机级**口味 | `lib/prefs.ts` 第 165 行的注释 | 外观主题文件也应是装机级；`design-system.md` 里「persisted as `localStorage[...]`」那句已经过时，落地时顺手改掉 |
| CSP：`style-src 'self' 'unsafe-inline'`，`img-src` 含 `ai-writer-asset:`，`font-src` 只有 `'self' data:` | `tauri.conf.json` | 主题带字体要给 `font-src` 加 `ai-writer-asset:`；**绝不**给 `img-src` / `font-src` 开远程（§11） |
| 自定义 fs 命令只认 `scope.rs` 里登记过的根 | `src-tauri/src/lib.rs:35` | 装机级 `themes/` 目录要在启动时登记为根，一行 |
| 项目级「文件覆盖内置」已有先例：`.ai-writer/workflows/*.md`，同 id 整张覆盖 | `lib/workflow/scan.ts` | 排版主题的项目级目录照抄这个形状 |

## 2. 目标与非目标

**目标**

1. 作者能往一个目录里丢一份 CSS 文件，重启（或点「重新载入」）后它出现在设置里，选中即生效，重启后仍在。
2. 一份主题文件可以**不完整**：只改一个强调色的主题是合法主题。
3. 排版主题跟着导出走：作者屏幕上看到的 HTML / PDF 就是文件里的。
4. 应用的每一处颜色都跟主题走，包括今天的盲区（编辑器高亮、Mermaid、原生滚动条与控件）。
5. 坏主题（解析不了、文件被删、选择器越界）**降级而不是崩溃**，并且在设置里说清楚哪里坏了。

**非目标**

- 不做主题商店 / 在线安装 / 自动更新。目录就是商店。
- 外观主题**不能**重排界面：不改布局、圆角、间距、字体（字体是 `data-font` 那根轴的事）。一个能改 `display` 的 UI 主题在每次发版都会坏，Typora 的 UI 主题也正因此常年破碎。
- 不做每项目的外观主题——打开别人的仓库不该把我的应用换个颜色。排版主题可以是项目级的（§6）。
- 不做可视化主题编辑器。做的是「导出当前主题为文件」这个起点（§10），编辑用作者自己的编辑器。

## 3. 概念模型：三根轴，两种文件

```
                 ┌──────────────── 外观主题 (ui theme) ────────────────┐
  data-theme  =  paper | night | <用户 id>       ← 一份 CSS，只声明令牌
  data-scheme =  light | dark                   ← 由主题的 manifest 决定，消费端只读这个
                 └──────────────────────────────────────────────────────┘
  data-font   =  manuscript | song | hei | kai   ← 不变
                 ┌──────────── 排版主题 (markdown theme) ───────────────┐
  data-md-theme = manuscript | clean | … | <用户 id>  ← 一份 CSS，只作用于 .md-body
                 └──────────────────────────────────────────────────────┘
```

- **模式**（浅 / 深 / 跟随系统）仍是 `app:theme` 那个偏好，含义不变，所以不需要迁移。新增两个偏好 `app:themeLight` / `app:themeDark`（默认 `paper` / `night`）：模式解出明暗，明暗选出主题。「跟随系统」于是是**一对**主题，不是一个。
- `data-scheme` 是新的：它是主题的**明暗极性**，由主题文件的 `@scheme` 声明，写在 `<html>` 上，`color-scheme` CSS 属性也跟它走（原生滚动条、`<input>`、日期控件从此跟主题）。消费端——Mermaid、模块 CSS 里那 2 处、图片降级边框——一律改读 `data-scheme`，**永不**读 `data-theme` 的值。`data-theme` 的值从此只是选择器的钥匙。
- 排版主题与外观主题正交，但排版主题的**颜色**默认全部引用外观主题的令牌（今天已经如此：`--md-color-text: var(--color-text-primary)`），所以一套排版跟着任何外观都成立。排版主题**可以**自带颜色（公众号那套要固定的品牌色），代价是它在夜间也是那个颜色——作者的选择，文件里写了就尊重。

## 4. 令牌分层与「基底 + 覆盖」的级联契约

把今天扁平的 214 个令牌分成三层，并用 CSS 级联层（`@layer`）把顺序写死：

| 层 | 内容 | 谁能写 | 例 |
|---|---|---|---|
| L0 刻度 | 间距、圆角、字体栈、缓动、布局尺寸（`:root` 的 55 个，`--glass-blur` 也搬来了——它两套一样） | 只有应用；主题文件里出现即丢弃 | `--space-4`, `--radius-md`, `--font-serif` |
| L1 核心 | **37 个**：六个底、五档文字、sienna / amber 四个、三条边、success / warning / error、八个模型类型色、五个阴影、玻璃三个。这是**主题契约**——一份主题文件被期待写的全部 | 内置基底必须全写；用户主题写任意子集 | `--color-bg-base`, `--color-sienna`, `--shadow-lg` |
| L2 推导 | **其余 176 个**：扩展的 `--color-*` 角色（AI 面板那 50 来个）+ `--lore / --stg / --sync / --rp / --snip / --writer` | **默认从 L1 推导**（`tokens.derive`）；内置主题保留设计师的手调值作为覆盖（`tokens.theme`，两套各 139 个）；用户主题可以覆盖但通常不碰 | `--stg-accent: var(--color-sienna)`、`--lore-wall-grid: color-mix(in srgb, var(--color-text-primary) 3%, transparent)` |

起草时把 `--color-*` 全部 88 个都算成契约；实现时收成 37 个核心，理由是设计稿 1f 的那份导出样例只列了六个令牌——`bg / bg-elev / border / text / text-dim / accent`——而一个改了强调色的用户主题若必须同时手写 `--color-bg-tabstrip`，那六行就是假的。哪些是核心、哪些是推导是**机械判定**的：推导式在两套内置里都能**精确**复现设计值的（纯 `var()` 别名）只留推导式，其余一律进 `tokens.theme` 手调，所以内置主题一个像素不动。

级联顺序（`@layer` 声明一次，之后不论样式表从哪里、以什么次序注入，顺序都成立）：

```
@layer tokens.scale,     /* L0，:root                                     */
       tokens.derive,    /* L2 的推导式，:root，全部是 var()/color-mix()     */
       tokens.scheme,    /* 两套内置基底的 L1：[data-scheme="light"|"dark"]  */
       tokens.theme,     /* 内置主题的 L2 手调：[data-theme="paper"|"night"] */
       tokens.user;      /* 用户主题文件：[data-theme="<id>"] { L1 子集 }     */
```

这一套顺序解决了三件事：

1. **用户主题可以只有十二行。** 它叠在 `tokens.scheme` 的同极性基底之上，没写的令牌由基底补齐。「不完整的主题是合法主题」不是校验器的宽容，是级联的性质。
2. **用户主题不会带着内置主题的手调色。** `[data-theme="paper"]` 的 L2 手调只在 `data-theme` 等于 `paper` 时命中；用户主题把 `data-theme` 换成自己的 id，手调层自然失效，L2 退回 `tokens.derive` 的推导——于是一个改了强调色的用户主题，设置页的开关、知识库的分类点、同步的风险条全部跟着变。今天做不到这一点：`--stg-accent` 是写死的 `#A9512B`。
3. **内置主题一个像素都不变。** 手调值原样搬进 `tokens.theme`，只是选择器从 `[data-theme="light"]` 改成 `[data-theme="paper"]`。S1 不靠截图守这条：一个脚本把旧文件每个令牌的字面值和新文件按级联解析出来的值逐一比对（两套各 248 个，0 处差异），再在浏览器里用 `getComputedStyle` 复核一遍（唯一的差异是 LightningCSS 把 `#A0522D` 写成 `sienna`、`rgba()` 写成八位 hex——同一个颜色）。

`tokens.derive` 的质量是 S1 真正的工作量：176 条推导式要在两套内置主题上都「像手调的」。验法是把手调层临时注掉截图对比，不追求逐像素，追求「看不出是推导的」。推导写不出来的（`--sync-badge-del-*` 那种反色芯片）就留手调，并写清为什么。**这一步 S1 没有做**：推导式写了，但「注掉手调层看一眼」要等 S2 有了第一份用户主题才有意义，到时按那份主题看。

`color-mix()` 在 Chromium 111 / WebKit 16.2 起可用——**在 `webviewCaps.ts` 的地板（Chromium 107 / WebKit 16）之上**，而那份文件的规矩是探针只能探地板以下的东西，所以它不进探针，改由 `tokens.derive` 里的 `@supports not (color: color-mix(…))` 分支兜底：混色令牌退成纯 `var()` 别名。进探针的是 `@layer`（Chromium 99 / WebKit 15.4）：没有它，内置主题靠源码顺序仍然正确，但 S2 装进来的用户主题会输给内置手调。

**LightningCSS 会改写 `@layer` 声明语句。** 打包时文件开头那句 `@layer a, b, c, d, e;` 被丢掉，改成按各层**首次出现**的顺序，末尾补一句 `@layer tokens.user;`。所以块在文件里的顺序必须和声明的顺序一致（`themeContract.test.ts` 钉着），否则源码和产物的级联不同——这是 2026-09-06 打包后 grep 出来的，不是推断。

## 5. 主题文件格式（照 Typora 的约定）

一个主题 = **一份 `.css` 文件** + 同名文件夹里的可选资产（字体、纹理图）。这正是 Typora 的 `theme-name.css` + `theme-name/` 约定，作者不用学新东西。元数据是**几条 `--theme-*` 自定义属性**，和令牌写在同一个块里（设计稿 1f / 1z 的改法，取代了起草时的 `==theme==` 注释块）：

```css
/* 外观主题 · 只声明令牌。布局、圆角、字体不在此列。 */
:root {
  --theme-name: 宣纸;            /* 网格里显示的名字 */
  --theme-kind: ui;              /* ui | markdown（缺席 = ui） */
  --theme-scheme: light;         /* ui 必填：light | dark，决定它属于哪一头 */
  --theme-extends: paper;        /* 没写到的令牌从这套内置取；markdown 默认 manuscript */
  --theme-version: 1;            /* 可选 */
  --theme-author: 某某;          /* 可选 */

  --color-bg-base: #F3EEE3;
  --color-sienna:  #7A5C3E;
  --color-sienna-hover: #5F4630;
}
```

为什么是自定义属性而不是注释块：校验器本来就要用浏览器的 `CSSStyleSheet` 把文件解析一遍，元数据写成属性，**同一次解析就读到了**，不用再写一个注释解析器；作者写 `:root` 是本能，安装时改写成 `[data-theme="<id>"]`；「读不出元数据」的判定也因此只有一条——`--theme-name` 或 `--theme-scheme` 缺席（设计稿 1c 屏 02 的措辞正是这个）。`--theme-*` 这几个名字自然不在契约清单里，校验器把它们当元数据摘走，不当令牌装上。

为什么是 CSS 而不是 JSON：排版主题的精华是**规则**（杂志的首字下沉、公众号的标题色条），JSON 表达不了；作者会 CSS；Typora 十年的主题生态证明了这条路的门槛是对的。一份文件就能拖进来，也就能一份文件分出去。

**外观主题（`@kind ui`）的规则**——校验器逐条执行，不合规的**丢弃并计数**，不整份拒绝：

- 顶层规则只允许 `[data-theme="<本文件 id>"]` 一种选择器（id = 文件名去后缀）。写成 `:root` 的照样接受，安装时改写成前者——作者写 `:root` 是本能。
- 声明只允许 `--` 开头的自定义属性，且名字在 L1 / L2 契约清单里。`display: none` 一类的普通属性丢弃：**UI 主题是令牌，不是样式表**（§2 非目标）。
- `@media (prefers-color-scheme)` 不接受——极性由 `@scheme` 决定，不由系统决定，否则「跟随系统」那一对主题就打架。
- `@font-face` 接受（主题可以带字体给 `--font-*` 之外的用途？不——字体是另一根轴，UI 主题不带字体；`@font-face` 只在排版主题里接受）。

**排版主题（`@kind markdown`）的规则**：

- 顶层选择器必须以 `.md-body` 开头（Typora：`#write`）**并且留在里面**：后代与 `>` 可以，`~` / `+` 不行——它们从 `.md-body` 起步却往旁边走，选中的是预览容器的**兄弟**，那是应用外壳（知识库阅读模式的 mono 边注就紧挨着正文，编辑器那边是工具条），而 `!important` 是照收的。只看深度 0 的组合器：`:nth-child(2n+1)` 里的 `+`、属性选择器里的 `~=` 都不是组合器，`.md-body:has(+ .x)` 的主体仍是 `.md-body`。两种拒绝各有各的话（`mdSelector` / `mdCombinator`）。`@media` / `@supports` / `@container` 容器里的规则递归检查同一条。`@font-face` / `@keyframes` 接受。
- 不接受 `:root`、`html`、`body`——想改颜色就在 `.md-body { --md-color-accent: … }` 里改。
- `url()` 只接受相对路径（相对本 css 文件，解析进同名文件夹）、`data:`；其它一律丢弃。相对路径安装时改写成 `ai-writer-asset:` 协议 URL，导出时内联成 `data:`（§9）。

校验**用浏览器自己的解析器**：`new CSSStyleSheet().replaceSync(text)` 之后遍历 `cssRules`，读 `selectorText` 与 `style`，不合规的 `deleteRule`。零依赖，且它解析出来的就是它将要渲染的——不会有「校验器放过了、渲染器读歪了」的缝。走完的表通过 `document.adoptedStyleSheets` 装上（原子替换、不进 DOM、切主题时换引用即可）。丢弃的条目带着「第几条、什么选择器、为什么」进 manifest 的 `problems[]`，设置页的卡片显示出来。

## 6. 存放位置与扫描

| 什么 | 哪里 | 为什么 |
|---|---|---|
| 外观主题 | 装机级 `appDataDir/themes/*.css` | 主题是口味，属于这台机器（`prefs.ts` 165 行同一条理由）；一个项目不该给我的应用换色 |
| 排版主题（装机级） | 同一目录，靠 `@kind` 区分 | 作者只需要知道**一个**「主题文件夹」 |
| 排版主题（项目级） | `.ai-writer/themes/*.css` | 公众号项目有自己的品牌排版，随仓库走；形状照 `.ai-writer/workflows/`：同 id 项目**整份**覆盖装机级 |
| 内置 | 代码里（`tokens.css` 与 `markdownThemes.ts`） | 内置永远不可删、不可被同 id 覆盖：`paper` / `night` / 五套排版的 id 保留字 |

扫描时机：**启动时只读被选中的那一到三份**（浅色主题、深色主题、排版主题），目录整扫在设置页打开时做，加一个「重新载入」按钮（Typora 要重启，我们至少给按钮；文件监听见 §15）。装机级目录在 Rust 启动时 `scope.allow`，否则自定义 fs 命令读不到它；项目级目录已在项目根之内。

**没有目录 = 没有用户主题**，不是错误；应用第一次「打开主题文件夹」时创建它。

## 7. 运行时

### 7.1 模块

```
src/lib/theme/
  manifest.ts     纯：读 --theme-* 元数据、给默认值、算 id（文件名去后缀）
  contract.ts     纯：tokens.css 的解析器——刻度 / 核心 / 推导三张名单 + 内置基底的值
  contractData.ts 生成物：上面那份解析冻成常量（scripts/gen-theme-contract.ts），测试钉着它和文件一致
  validate.ts     校验器：走 CSSRuleList 的形状（RuleLike）、丢弃并计数、problems[]；parseCssRules 是 DOM 侧唯一入口
  registry.ts     内置 + 扫描出来的主题的合并视图（ThemeEntry[]），排序、id 保留字、missing
  scan.ts         唯一碰盘处：appDataDir/themes 的读取（照 workflow/scan.ts）
  install.ts      两个 <style> 的装卸（外观全部装、排版只装选中的那份）、注册表的运行时状态、订阅、项目目录的进出；data-theme / data-scheme 经 scheme.ts 写入
  assets.ts       排版主题的资产：相对 url() 读成 data: URL（装载与导出同一个变换）
  sample.ts       设置页排版卡的样张文档：沙箱 iframe 的 srcdoc（当前外观的一套调色板 + 基底 + 文件自己的 CSS + 一页样文）
  export.ts       导出的调色板：浅深两套核心 + 排版 CSS 引用到的推导令牌，从注册表生成
  exportFile.ts   「把当前主题导出为文件」：每个令牌带角色注释的 .css，写进主题文件夹
  markdownThemes.ts  保留：内置排版主题 + 基底生成器；EXPORT_TOKEN_CSS 与「钉住」块都已删除（§9、§7.3）
```

`contractData.ts` 是**生成物**而不是第二份手抄：vitest 把每一个 `.css` 导入都 stub 成空（`?raw` 也不例外），而要读契约的模块（校验、导出）在 `appStore` 之下、半个测试套件都会导入——所以运行时不能 `import tokens.css?raw`。`themeContract.test.ts` 用同一个解析器跑一遍文件、和常量 `toEqual`，漂了就报出重新生成的命令。

`ThemeEntry` 是设计稿和设置页的**数据边界**：

```ts
interface ThemeEntry {
  id: string;                    // 文件名去后缀；内置是保留字
  kind: "ui" | "markdown";
  name: { zh: string; en: string } | string;   // 内置双语；用户单语
  scheme?: "light" | "dark";     // 仅 ui
  extends: string;               // 基底 id
  source: "builtin" | "user" | "project";
  path?: string;                 // 用户/项目主题的文件路径
  version?: string; author?: string;
  problems: { rule: number; selector?: string; reason: string }[];  // 空 = 干净
  missing?: boolean;             // 偏好里选着它、磁盘上找不到
}
```

### 7.2 切换与启动

- `appStore.setTheme(mode)` 语义不变。新增 `setThemeFor(scheme, id)`。三者任一变化 → 解出 `(id, scheme)` → `install.applyResolvedTheme(scheme, id)`：注册表解出真正生效的那张（文件缺席 / 读不出 / 极性不对就是内置基底）、经 `scheme.applyThemeId` 写 `data-theme` / `data-scheme`（`color-scheme` 由 `tokens.scheme` 跟着 `data-scheme` 走）。仍包在 `startViewTransition` 里，交叉淡化照旧。**每一份可用的用户主题都装在同一个 `<style>` 里**（`@layer tokens.user { [data-theme="id"] {…} … }`），切换只是换属性，不读文件。用 `<style>` 而不是 `adoptedStyleSheets`：构造样式表 WebKit 16.4 才有，在地板之上；层让注入位置无关紧要。
- `setMarkdownTheme(id)` 同理走 `install.applyResolvedMarkdownTheme(id)`：`data-md-theme` 写的是**它叠的那套内置**（文件是内置就是它自己），文件自己的 CSS 装进第二个 `<style>`（`theme-markdown-user`，排在生成器那份之后），资产已内联；选内置就清空这份。一次只装选中的那一份——Typora 的语义；样张不需要更多，它们各有各的沙箱。校验器发出的每个选择器前面都带 `html[data-md-theme]`：叠底那套内置的规则是 `[data-md-theme="x"] .md-body …`，比文件里的 `.md-body …` 多一个属性选择器，不加前缀的话文件写的 `--md-line: 1.9` 会输给基底的 `1.78`，源码顺序救不了。
- **启动无闪**：`main.tsx` 今天已经 `await hydratePrefs()` 之后才 import 应用；把「读被选中主题文件并校验」放进同一个 await——多一次文件读取，换来首帧就是对的主题。文件不在：写基底、把 entry 标 `missing`，设置页的那张卡说「找不到 xxx.css，已回到 paper」，偏好**不**自动改写（作者把文件放回来就好）。
- `reloadFromPrefs()`（配置导入后重绘）也走同一条：偏好里的主题 id 可能指向这台机器没有的文件，处理同上。

### 7.3 设置页的样张必须隔离

设置页整页做了 `--color-* → --stg-*` 重映射，任何画在页内的样张都会被染色；而用户排版主题的 CSS 又无法像内置那样「钉住」到一张卡。两个问题一个解：**每张排版主题卡是一个 `<iframe sandbox srcdoc>`**，文档 = §9 的导出样式 + 一段样文。卡片显示的就是导出出来的样子，内置和用户主题用同一种卡，「钉住」机制随之退役。沙箱**不加** `allow-same-origin`——与 pptx harvester 同一条纪律；`frame-src` 已允许 `about: blob: data:`。

外观主题卡不需要 iframe：它的样张是**令牌本身**——一块由 `--color-bg-base / -surface / -elevated / -accent / -text-primary` 画出的迷你窗口（侧栏带 / 编辑区 / 右栏 / 一个强调色点），从 entry 装出的样式里读值，不截图、不写死。

## 8. 消费端要跟上的地方（主题盲区清单）

| 盲区 | 今天 | 改成 |
|---|---|---|
| 编辑器语法高亮 | `defaultHighlightStyle`（浅色写死） | 自建 `HighlightStyle`，颜色全部是 `var(--color-*)` 字串（CodeMirror 接受 CSS 变量作值）；模块 CSS 里的 `.tok-*` 覆盖并入其中 |
| Mermaid | `data-theme === "light" ? default : dark`，只在渲染时读一次 | 读 `data-scheme`；`themeVariables` 从令牌取值（`getComputedStyle` 一次）；主题切换后重渲染已渲染的图（Preview 订阅 scheme） |
| 原生控件与滚动条 | 不跟主题 | `:root { color-scheme: light|dark }` 随 `data-scheme` |
| 首帧窗口底色 | Tauri 默认（白） | `tauri.conf.json` `backgroundColor` 或启动时 `set_background_color` 取偏好里深浅对应的 `--color-bg-base` 常量（两个内置基底的值写死即可，用户主题首帧差一帧可接受） |
| 模块 CSS 里 36 处硬编码 | `#fff`、遮罩、`#e81123` | 遮罩 `mask-image` 的 `#000` 与 Windows 关闭键的系统红**保留**（不是颜色语义）；其余换令牌 |
| `data-theme` 直读 2 处 CSS + 1 处 TS | 认字面 `light` | 全部改 `data-scheme` |
| 导出 | 永远浅色 | §9 |

## 9. 导出

`EXPORT_TOKEN_CSS` 那份手抄调色板删除，改为 `theme/export.ts` 从注册表**生成**：

```
:root                                  { L0 里导出需要的字体栈 + 当前浅色主题的 L1 }
@media (prefers-color-scheme: dark) :root { 当前深色主题的 L1 }
:root { color-scheme: light dark }
+ md 基底（现有生成器，scope = body）
+ 被选排版主题：内置 → 生成器的 vars/rules；用户 → 校验后的 CSS 文本，url() 内联为 data:
```

于是：作者的用户外观主题第一次进入了导出文件；导出的 HTML 在收件人的深色系统里也是作者深色主题的样子；PDF 走打印，浮出的仍是浅色那套（打印是纸）。用户排版主题带的字体随文件内联——一份带 20MB 字体的主题导出一份 20MB 的 HTML，那是作者的选择，导出对话框显示体积即可。

## 10. 设置界面（交给设计稿的部分，细节见任务书）

落点仍是 设置 → 通用 → 外观，但这一节要长出四样东西：

1. **模式 × 主题的配对**：浅 / 深 / 跟随系统 三个芯片不变；下面是两组主题卡「浅色时用」「深色时用」——跟随系统时两组都在，选定浅色时深色那组折起。这是「跟随系统是一对主题」在界面上的样子。
2. **两种来源并排**：内置 / 我的 / 本项目（排版主题才有第三种），来源是卡上的一个 mono 边注，不是三个分组——作者选主题时不关心它从哪来。
3. **坏主题的样子**：卡片留在原地，样张位置换成一句 mono 说明（「第 3 条规则 `body` 越界，已忽略」「找不到文件，已回到 手稿」）。永远不弹窗。
4. **作者入口**（一行三个动作，长在网格底下）：打开主题文件夹 · 重新载入 · **把当前主题导出为文件**。第三个是整套系统的**上手路径**：它写出一份完整的、每个令牌带角色注释的 `.css`（内置基底的全部 L1），作者改几行、改个名、放回去。Typora 的文档说「复制一份现有主题开始」，我们把这一步做成按钮，而且导出的永远是当前版本的令牌，不会像手抄那样过期。

## 11. 安全边界

- **CSS 键盘记录器**（属性选择器逐字符匹配 `value` + 远程 `url()` 回传）是主题文件的经典攻击。它的前提是远程加载。CSP 的 `img-src` / `font-src` 今天没有任何远程主机，本方案只加 `ai-writer-asset:` 到 `font-src`；**永远不为了主题给这两项开 `https:`**。`@import` 远程同理被 `style-src 'self'` 拦住。
- 构造样式表（`adoptedStyleSheets`）不受 `style-src` 约束（CSSOM 操作按规范免检），这与今天 `'unsafe-inline'` 的现状等价，没有放宽。
- UI 主题只能写 `--` 属性，改不了任何元素的 `display` / `position` / `content`，所以它不能遮住批准卡、不能把「删除」按钮画成「取消」。排版主题只到 `.md-body` 之内，同理够不到应用外壳。
- 主题文件来自作者自己的磁盘或项目仓库。项目级排版主题是**唯一**能从别人那里带进来的一份，它的能力被 `.md-body` 围住，且不能远程加载——一个恶意仓库最多把预览画得难看。围住这件事有两半，而第二半曾经漏掉：`.md-body ~ *` 从围栏里起步、一步跨到外面，够得着应用外壳；`staysInsideMdRoot` 补上了它（§5）。项目文件按 id 顶掉装机级同名主题这条路，也让「顶掉」成为一种能力：所以被拒绝的项目文件（放错格的外观主题）**不参与**顶替，否则一个 `brand.css` 就能让作者自己那份能用的 `brand` 排版主题在打开该项目时静默消失。
- 装机级 `themes/` 是 `scope.rs` 里新登记的根，只读；写入只有 §10 那个「导出为文件」，写进同一目录。

## 12. 测试与不变量

- `themeTokenParity.test.ts` → **契约测试** `themeContract.test.ts`（S1 已落地）：五层声明语句在文件开头且块按同一顺序出现；核心 = `tokens.scheme` 两个块的交集 = 并集（内置基底必须完整），且核心不在任何推导 / 手调块里；手调 = `paper` 与 `night` 同一集合、不碰刻度；每个推导令牌在 `tokens.derive` 的 `:root` 有默认**或**在两个 `[data-scheme]` 块都有（不能三处都没有），且两种写法二选一。S2 的 `contract.ts` 常量从同一份解析里导出，不另抄一份。
- **悬空引用守卫**（S1 第一天就加，不等主题文件）：扫 `src/**/*.css` 与 `markdownThemes.ts` 里每一个 `var(--x)`，`--x` 必须在契约清单里或在同一文件内声明（`--md-*` 与组件自己的局部变量）。2026-09-05/06 三个 PR 修的 `--color-danger` / `--color-red` / `--color-text` 都是这一类，`var()` 退成 `initial` 时没有任何东西报错。这条守卫也是主题文件安全的前提：用户主题写错令牌名时，校验器靠的正是同一份清单。
- `manifest.test.ts`：注释块解析、默认值、非法 `@scheme`、缺 `@kind`、id 与文件名的关系。
- `validate.test.ts`（vitest 有 jsdom；`CSSStyleSheet.replaceSync` 若缺则用 happy-dom 或把遍历逻辑抽成对 `CSSRuleList` 形状的纯函数喂假对象）：`:root` 改写、普通属性丢弃、`body` 选择器丢弃、`@media` 递归、`url()` 白名单与改写、`problems[]` 的措辞。
- `registry.test.ts`：项目覆盖装机、内置不可覆盖、`missing` 的产生。
- `export.test.ts`：生成的样式含两套 L1、含 `color-scheme`、用户 CSS 原样、`url()` 已内联；**不再**含 `EXPORT_TOKEN_CSS` 字样（棘轮）。
- 源码守卫（同一个测试文件）：`src/**` 不得出现 `data-theme="light"` / `"dark"` 字面量比较；`getAttribute("data-theme")` 只允许出现在 `lib/theme/scheme.ts`（S2 的 `install.ts` 通过它写，不自己读）。
- S1 的零像素验证**不是截图**：一个一次性脚本把旧文件每个令牌按旧级联解析出的字面值，和新文件按新级联（theme → derive[scheme] → derive → scheme → scale，`var()` 递归代入）解析出的值逐一比对，两套各 248 个、0 处差异；再在开发服务器里对两套主题各跑一遍 `getComputedStyle(html).getPropertyValue`，与旧字面值比对，差异只有 LightningCSS 的等价改写（`#A0522D` → `sienna`、`rgba()` → 八位 hex）。截图只用来看一眼没有整体翻车。

## 13. 分片（每片一个 PR，实机测过再下一片）

| 片 | 内容 | 可见变化 |
|---|---|---|
| **S1 令牌分层** — **已落地 2026-09-06** | `@layer` 五层；`data-scheme` + `color-scheme`（`lib/theme/scheme.ts`：`applyScheme` / `currentScheme` / `useScheme`）；核心 37 / 推导 176 / 手调 139；`[data-theme="light"]` → `paper` / `night`；Preview 的 Mermaid 读 scheme 并在切换时重渲染；CodeMirror 高亮改成 `lib/editor/highlight.ts`——只发 `.tok-*` 类名，颜色在模块 CSS 里读令牌（原来的 `.tok-*` 规则一直是死代码：`defaultHighlightStyle` 生成的是哈希类名）；16 处主题盲的字面色换令牌（图片灯箱那一族的白字黑底是刻意的，保留）；`themeContract.test.ts` 替换奇偶测试并带悬空引用守卫（首轮抓到 `--color-bg-panel` / `--color-red` / `--spring-open` 三处）；`webviewCaps` 加 `@layer` 探针 | 内置主题**零像素变化**（脚本 + 浏览器双重核对）；夜间编辑器高亮、原生控件 / 滚动条、Mermaid 跟主题了 |
| **S2 外观主题文件** — **已落地 2026-09-06** | `manifest / contract(+contractData) / validate / registry / scan / install / export / exportFile`；`app:themeLight/Dark` + `setThemeFor`；`main.tsx boot()` 只预读被选中的文件；设置页两条带 + 六令牌样张卡 + 三种坏卡 + 就地「详情」+ 作者三动作与两处痕迹；导出调色板改从注册表生成（`EXPORT_TOKEN_CSS` 删除，棘轮测试守着）。**与方案的出入**：① Rust 侧**没有改动**——`appDataDir` 本来就在 `scope.rs` 的根里，`themes/` 是它的子目录；② 装载用 `<style>` 不用 `adoptedStyleSheets`（§7.2）；③ `problems[].rule` 是文件里**第几条顶层规则**而不是行号——CSSOM 不给行号，设计稿的「第」列照这个填；④ 外观卡的样张不读值：卡上的迷你窗口自己带 `data-theme` / `data-scheme`，`tokens.scheme` 与 `tokens.user` 在**它身上**声明那六个核心令牌，压过设置页 `--stg-*` 重映射的继承值，内置与用户主题同一种画法；⑤ 校验器遍历的是 `CSSRuleList` 的**形状**（`RuleLike`），单测喂普通对象——node 里没有 CSSOM；⑥ 「重新载入」的痕迹只数外观（排版文件计数已收进 `UiRegistry.markdownFiles`，S3 接）。实机之外的核对：dev server 里把四份真实 CSS 文本喂进真的浏览器解析器——`"冷灰"` 引号剥掉、`--radius-md` / `--color-danger` / `body` / `.editor` / `@media (prefers-color-scheme)` 五条各带各的理由被丢、缺元数据的文件不可选、偏好指着不存在的文件时虚线卡站在原位、选中用户主题后 `--stg-accent` 跟着它的 `--color-sienna` 变 | 作者能装自己的外观主题；导出带作者调色板（浅色在 `:root`，深色在 `prefers-color-scheme: dark` 下） |
| **S3 排版主题文件** — **已落地 2026-09-06** | `--theme-kind: markdown` 的校验（`validateMarkdownRules`：每个选择器以 `.md-body` 起、`@media / @supports / @container` 递归、`@font-face / @keyframes` 照收、`url()` 只收相对路径与 `data:`、`:root` 只读 `--theme-*` 元数据）；项目级 `.ai-writer/themes/`（同 id 整份覆盖装机级，随 `projectStore.projectPath` 进出注册表；外观主题放进去会被拒并说明）；样张改成 `<iframe sandbox="" srcdoc>`（内置一并迁过去，生成器的「钉住」块删除）；`自带字体` / `自带颜色` 两个 mono 小框；重新载入的痕迹数两种；导出带文件自己的 CSS。**与方案的出入**：① 资产**不走 `ai-writer-asset:`**，装载和导出都内联成 `data:` URL——应用自己的图片早已弃用那个协议（WebView2 对盘符路径的解析不可靠，`useImageDataUrl.ts` / `protocol.rs` 记着），一个变换喂两处也让样张、应用、导出三处不会对一个字体各说各话；因此 `font-src` **没有**加协议，CSP 一字未动；② Rust 侧一行：`themes/` 目录再登记进 `tauri-plugin-fs` 自己的 scope（读字体字节走的是那个插件，它的 scope 只种了项目根）；③ 校验器发出的选择器带 `html[data-md-theme]` 前缀（§7.2 说了为什么），导出的 `<html>` 与样张的 `<html>` 因此也带这个属性；④ `problems[].rule` 在嵌套块里记的是**顶层**规则号；⑤ 样张里没有应用打包的字体（沙箱是不透明源，`font-src 'self'` 对它不成立），退到系统字体——字体方案那根轴不进样张；⑥ `background` 这类简写经 CSSOM 展开成长属性再发出，正确但啰嗦。实机之外的核对：dev server 里把三份真实排版 CSS 喂进真的浏览器解析器——`body { … }` 被丢、`@media` 递归保留、`半调.css` 缺名不可选、`brand.css` 标成「本项目 · 自带字体 · 自带颜色」、选中 `宋楷` 后 `data-md-theme=manuscript`、第二个 `<style>` 里是它的规则、探针元素上 `--md-line` 读到 `1.9` | 作者能装 Typora 式排版主题，导出一致 |
| **S4 打磨** — **已落地 2026-09-06** | ① **文件监听**：`tauri-plugin-fs` 开 `watch` feature（`notify` 进依赖，Rust 代码零改动，capability 加 `fs:allow-watch / allow-unwatch`），`stores/themeStore.ts` 在设置页打开时监听装机级与项目级两个目录（不存在的不监听；「打开主题文件夹」建好目录后重开），插件自身 300ms 去抖 + 我们 250ms 合并，变动即重新载入并留同一道痕迹「文件夹有变动，已重新载入 · …」，导出的粘性痕迹不被它盖掉；设置页关掉就停。② **`problems[].reason` 改成代码**（`ThemeReasonCode` 18 个 + `params`），句子住在 `systemSettings.general.reason.*`，中英各一套，卡片渲染时翻译；测试钉代码不钉散文。③ **简写回收**：校验器逐条判定后 `removeProperty` 掉被拒的与 `--theme-*`，再发引擎自己的 `style.cssText`——`background: #fff` 回到一条而不是八条长属性；发出的块因此是单行 `{ a: b; c: d; }`。④ **样张与导出跟字体方案**：`contract.fontSchemes` 从 `[data-font]` 块解析，`exportPaletteCss` 多一个 `fontScheme`，宋 / 黑 / 楷的栈本就以系统字体打头、原样进沙箱与导出；手稿仍用带 CJK 回退的默认块（Spectral 在沙箱里读不到，退到 Georgia / Songti）。**与设想的出入**：监听走插件的 `watch` 而不是自写 Rust 命令——它底下就是 `notify` + `notify-debouncer-full`，我们要的正是去抖过的目录事件 | 改主题文件保存即见；英文界面下坏主题的理由是英文；导出文件里 `background` 一条 |
| **S5 第二套外观主题 石 / 墨** — **已落地 2026-09-06** | 设计稿 `05j 第二套主题 Second Theme`（TURN 1 三个方向，取推荐的「石墨 Graphite」：冷灰中性 + 青黛强调）落成两张**内置**卡：`[data-theme="stone"]` / `[data-theme="ink"]` 写在 `tokens.theme` 层，**只有那 37 个核心、一个手调都没有**。这一片同时把 §4 末尾那句悬着的话答掉了——「注掉手调层看一眼要等 S2 有了第一份用户主题才有意义」：石 / 墨 就是那份主题，只不过它随应用出厂。`contract.ts` 因此改了一行——`derived` 减掉核心名：纸 / 夜 是**基底**，它们在这一层写的只有推导令牌；石 / 墨 不是基底，核心无处可去（基底层按极性作键，不按主题），只能写在同一层，而层不能决定层级，`tokens.scheme` 才是。测量：正文 13.9:1 / 次级 6.6:1（夜侧 9.0）/ muted 3.4:1，青黛在两张底上 5.10 / 5.43，四个类型色 fg-on-bg 全部 ≥ 4.5（纸自己是 3.73–4.86）；知识库六色**全部推导**，最近的一对（物品–事件）oklab ΔE 石 0.069 / 墨 0.047，同一对在纸是 0.073、夜是 0.025（纸自己最近的一对是 地点–概念 0.068）——推导出来的六色比手调的那两套**分得更开**，所以没有为它开任何手调。设置页那一档掺白也核过：石的 页/输入框 分离 1.044，纸是 1.033 | 作者开箱多一对冷灰主题；换上它，设置页开关、知识库分类点、同步风险条全部跟着青黛走——推导层第一次在没有手调兜底的情况下被看见 |
| **S6 第三套外观主题 霜 / 靛** — **已落地 2026-09-07** | 同一份设计稿 `05j` 的第二选「靛 Indigo」（深色为主角：底是靛墨而不是黑；浅色那张是同一套色相调亮后的白天）落成第三对**内置**卡：`[data-theme="frost"]` / `[data-theme="indigo"]`，与石 / 墨 一样**只写那 37 个核心**。稿子在这个方向上自留了一处待盯——「靛青×金褐是互补色，oklab 混出来的事件色接近灰紫，与势力（灰蓝）要靠色相勉强分开；深色侧更明显」——**照 S5 那套测法量过：不用改**。六色最近的一对，霜是 势力–概念 ΔE **0.081**、靛是 势力–概念 **0.057**，而各自最近的一对是 纸 0.068（地点–概念）/ 夜 0.025 / 石 0.069 / 墨 0.047：稿子担心的 事件–势力 在深色侧是 0.068，不是最近的那一对，浅色侧连前三都进不去。所以又一次**没有开任何手调**。其余测量：正文 14.1:1（两侧）、次级 6.9 / 8.9、muted 3.6 / 5.5，靛青在两张底上 5.73 / 6.73，四个类型色 fg-on-bg 全部 ≥ 4.5，设置页 页/输入框 分离 1.052（纸 1.033 · 石 1.044）。稿子给 14 个令牌，其余 23 个照 S5 的补法：类型色的 **L 与彩度照石、色相各自保住**（直接把锚色掺进蓝底会把橄榄掺成中性灰，四个芯片就不能靠色相扫读了）| 作者开箱有三对主题、六张卡；推导层第二次在没有手调兜底的情况下被看见，而这次是在一个**互补色**的强调色上 |

S1 是最大也最值钱的一片：它本身就是对今天「176 个只在两套内置里有值的令牌」的一次偿债，即便 S2–S4 永远不做，应用也已经能被一份 37 行的令牌文件整体换色——S2 要做的只是把那份文件读进来。S4 里「`design-system.md` Theming 一节重写、`localStorage` 那句删除」两项已随 S1 做掉；「坏主题的措辞与 i18n」的另一半（`problems[].reason`）随 S4 收成代码 + 两套句子。

## 14. 弃案

| 方案 | 为什么不 |
|---|---|
| JSON 主题格式 | 排版主题的价值在规则不在变量；作者会 CSS 不会我们的 schema；Typora 生态证明门槛在这里刚好 |
| 用 `@scope (.md-body)` 包住用户排版 CSS 以支持多主题共存 / 钉住 | WebKit 17.4 起才有，在地板之上但 macOS 14.4 以下没有；而「同时只有一套排版主题生效」本就是 Typora 语义，多主题共存只有设置页样张需要，iframe 解决得更干净 |
| 正则给用户 CSS 的选择器加前缀 | 选择器语法不是正则能切的（`:is()`、逗号在 `:not()` 里、`@media` 嵌套）；浏览器解析器就在手边 |
| 每项目的外观主题 | 打开一个仓库不该改我的应用颜色；而且它会和「跟随系统是一对」叠成四维矩阵 |
| Shadow DOM 隔离预览 | `.md-body` 有 5 个消费点，含知识库正文、扮演气泡；Shadow 树断掉选区映射、滚动同步、⌘F 与 `[[lore:…]]` 的事件冒泡，代价远超收益 |
| 让 UI 主题也能写普通样式（真「皮肤」） | 每次改版都会让所有第三方主题坏掉；Typora 的 UI 主题正是这样年年碎的。令牌是我们**能承诺兼容**的那一层，把承诺画在这里 |
| 主题热重载靠轮询 mtime | 见 §15；没有 watcher 之前宁可只给按钮 |

## 15. 开放问题

1. **文件监听**：~~Rust 侧目前没有 `notify` 依赖。S4 是否值得加一个 watcher 只为主题热重载？~~ 已做（S4）：`tauri-plugin-fs` 的 `watch` feature 就带着 `notify`，只监听两个 `themes/` 目录，且只在设置页开着时。
2. **`color-mix()` 探针失败时的降级质量**：`@supports not (color: color-mix(in oklab, red, blue))` 分支里 L2 只能是别名，不如推导；那台机器上用户主题的设置页会「平」一些。是否可接受，S1 实机看。
3. **导出的深色块要不要**：收件人的系统是深色时，公众号排版带品牌色 + 作者的夜间调色板可能不好看。备选：导出只带浅色（今天的行为），深色块作为导出对话框的一个开关。倾向：默认带，开关可关。
4. **排版主题自带字体与 `data-font` 的关系**：排版主题 `.md-body { font-family: … }` 会压过字体方案（后者只改 `--font-serif`）。这是预期（Typora 的主题就是带字体的），设置页在卡上标「自带字体 · 不随字体方案变」——S3 已做；判定是「值里没有 `var(`」，引用 `var(--font-serif)` 的不算自带。
5. **旧偏好值**：`app:theme` 从未存过 `paper`/`night`（它是模式），无迁移；`app:markdownTheme` 存的五个 id 全部保留为内置保留字，无迁移。唯一要动的是把 `design-system.md` 里那句 `localStorage` 改掉。
