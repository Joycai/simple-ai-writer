# Design System & Theming

> Read this before building or restyling **any** UI. `src/styles/tokens.css` is the implementation of these rules.

## Theming

- **System** — CSS variables (dark/light modes) set via `data-theme` attribute
- **Tokens** — `src/styles/tokens.css` (all design tokens: color/space/radius/shadow/easing/glass)
- **Global** — `src/styles/global.css` (resets, scrollbar, focus ring, reusable keyframes, reduced-motion)
- **Components** — CSS Modules per component (`*.module.css`); read from tokens, never raw values
- **Theme Modes** — dark, light, system (auto-detect)

## Visual Language (视觉规范)

The UI targets a restrained, modern **Apple-like aesthetic**. These rules are the source of truth.

### 核心原则 (Principles)
1. **令牌优先** — Always consume tokens (`var(--…)`). Never hardcode colors, shadows, radii, or easing in component CSS. If a value is missing, add a token, don't inline it.
2. **单一克制强调色** — One sienna accent (`--color-accent` → `--color-sienna`, light `#A0522D` / dark `#D9925B`). Tints via `--color-accent-tint` (base fills) and `--color-accent-tint-strong` (hover/selected fills). **No multi-color gradients on interactive elements.** Gradients are reserved for *decorative-only* surfaces: logo, `.gradient-text`, brand accent dot, icon badges.
3. **克制精致动画** — Short durations (120–320ms), Apple easing curves, subtle motion ("barely perceptible but smooth"). Avoid large/bouncy movement except brief spring accents.
4. **分层海拔** — Depth comes from the layered shadow scale, not borders alone. Pick the smallest shadow that reads.
5. **无障碍** — All motion must degrade under `prefers-reduced-motion` (handled globally — don't fight it). Keyboard focus uses the unified `:focus-visible` ring, not just a border-color swap.

### 令牌速查 (Token reference — `tokens.css`)
- **Easing**: `--ease-out` (enter/expand, default), `--ease-spring` (brief pop accents only), `--ease-in-out` (symmetric size/position).
- **Transitions**: `--transition-fast` (120ms, hover/press), `--transition-base` (200ms), `--transition-slow` (320ms, panels/drawers). All pre-bound to `--ease-out`.
- **Radius**: **all zero** (设计稿 01/04 收紧为全局无圆角 — the manuscript reads as cut paper, not rounded cards). The whole `--radius-*` scale is 0 in `tokens.css`; modules keep reading the tokens so a future turn of the dial is still one edit. The only sanctioned circles are dot indicators, spinners and radio marks — `border-radius: 50%` or `--radius-round`. Switch knobs are **square** (设计稿 04 draws the settings toggle as a flat square block — see 设置页色系 below). Never write any other literal radius, and don't "fix" a square control back to round.
- **Shadow (elevation)**: `--shadow-sm` (resting cards/inputs) → `--shadow-md` (raised) → `--shadow-lg` (popovers/menus/dropdowns) → `--shadow-xl` (modals). `--shadow-focus` for focus rings. Each theme defines its own set (dark deeper, light subtle).
- **Accent**: `--color-accent`, `--color-accent-hover`, `--color-accent-ring`, `--color-accent-tint`, `--color-accent-tint-strong`.
- **Tags**: `--color-tag-bg` / `--color-tag-text` for the neutral badge. Model-type tags get one hue each — `--color-type-{text,multimodal,image,video}-{bg,fg}` — so a model list is scannable without reading the labels.
- **Surfaces**: `--color-bg-base` → `--color-bg-surface` → `--color-bg-elevated`, plus `--color-bg-hover` for a *neutral* row hover. Use accent tint for **selected**, `--color-bg-hover` for merely **hovered** — tinting a hover reads as a selection that isn't there.
- **Glass**: `--glass-bg` (modals), `--glass-bg-strong` (large chrome), `--glass-blur`, `--glass-border`.
- **Typography**: `--font-serif` (body/editor), `--font-sans` (UI chrome/labels), `--font-mono` (code, numeric, prefix editor). Size scale `--font-size-xs` 11 → `--font-size-3xl` 44, with `--font-size-base` 14 sitting between `md` (13) and `lg` (17) for settings rows and nav items. Serif/sans are **swapped per font scheme** (see below); mono is fixed.

### 字体方案 (Font schemes — `data-font`)

User-switchable CJK × Western pairings, selected in Settings → 通用 → 外观. Chosen like themes: `<html data-font="…">` + override blocks in `tokens.css` that follow `:root` (equal specificity → later block wins). State + persistence live in `appStore` (`fontScheme` / `setFontScheme`, `localStorage["app:fontScheme"]`, re-applied on load). **System fonts only — nothing is bundled**, so every scheme ships a full Win/Mac/Linux fallback stack.

| `data-font` | 名称 | 西文 | 中文正文 | 观感 |
|-------------|------|------|----------|------|
| `manuscript` (default) | 手稿 | Spectral → Georgia | 宋体回退 | Current look, unchanged |
| `song` | 宋体书卷 | Georgia / Cambria | 思源宋 → 苹方宋 → SimSun | Printed-book serif |
| `hei` | 黑体清晰 | 系统无衬线 | 苹方 → 微软雅黑 → 思源黑 | All-sans, modern screen |
| `kai` | 楷体临帖 | Iowan / Georgia | 楷体 → STKaiti | Handwritten manuscript |

Each scheme overrides **both** `--font-serif` (editor body) and `--font-sans` (UI); `hei` points serif at a sans stack to make the whole app sans. To **add a scheme**: append a `[data-font="…"]` block in `tokens.css`, extend the `FontScheme` union + `FONT_SCHEMES` array in `appStore.ts`, add an entry (with a `previewFont` mirroring the serif stack) to `FONT_SCHEMES` in `settings/panes/GeneralPane.tsx`, and add `systemSettings.general.font*` labels to both locales.

### Markdown 排版主题 (Markdown themes — `data-md-theme`)

Every rendered-markdown surface — the editor preview pane, lore entry/facet previews, exported HTML and print/PDF — shares one look, picked in Settings → 通用 → 外观. Implementation: `src/lib/theme/markdownThemes.ts`.

Why CSS-in-TS instead of a `.module.css`: exported HTML is self-contained, so the same rules must be serialised into a `<style>` tag with no build step and no `tokens.css` around them (`EXPORT_TOKEN_CSS` re-declares the light palette there). One generator means the printed file matches what the author read; a stylesheet plus a hand-kept export copy would drift on the first tweak. This is the **only** sanctioned CSS-in-TS in the app.

| `data-md-theme` | 名称 | 观感 |
|-----------------|------|------|
| `manuscript` (default) | 手稿 | Serif, centred headings, 2em paragraph indent — fiction |
| `clean` | 素雅 | Sans, left-aligned, airy — reports, weeklies, docs |
| `magazine` | 杂志 | Display headings, section rules, drop cap — long-form |
| `wechat` | 公众号 | Centred headings with accent bars, compact body |
| `typewriter` | 打字机 | Monospace, visible `#` markers |

Rules of the road:

- A theme is a bag of `--md-*` custom properties consumed by shared base rules, plus an optional `rules` string (`&` = container selector) for signature touches. **Colours stay in design tokens** — that's what makes every theme follow dark/light for free.
- Containers carry the global `md-body` class (`MD_BODY_CLASS`); the theme comes from `data-md-theme` on `<html>` (state in `appStore.markdownTheme`, persisted as `localStorage["app:markdownTheme"]`). A container may set the attribute on *itself* to pin one theme regardless of the app setting — the settings picker's live samples do this, which is why the generator emits pinned blocks after inherited ones.
- **Size belongs to the surface, not the theme.** Surfaces set `--md-size` (preview pane 17px, lore entry 15px, facet field 14px, picker sample 10px); themes may only nudge it via `--md-scale`. The base defaults sit in `:where()` (zero specificity) because the stylesheet is injected *after* the app's CSS modules and would otherwise beat a plain surface class.
- To **add a theme**: append an entry to `MARKDOWN_THEMES` (id, zh/en label + desc, vars, optional rules) and extend the `MarkdownThemeId` union + `MARKDOWN_THEME_IDS`. The settings picker, persistence and export pick it up with no further wiring.

### 组件模式 (Required patterns)
- **Primary button**: solid `--color-accent`; hover → `--color-accent-hover` + `translateY(-1px)` + `--shadow-sm`; active → `translateY(0) scale(0.98)`; disabled → reduced opacity. Never opacity-only hover.
- **Tinted/secondary button**: `--color-accent-tint` bg + `--color-accent` text; hover → `--color-accent-tint-strong` (or solid accent + white text); active → `scale(0.96–0.98)`.
- **Icon/tab/control press**: `:active { transform: scale(0.92–0.96) }`.
- **Chrome surfaces** (sidebar, right panel, tab bar, status bar): `--glass-bg-strong` + `backdrop-filter: var(--glass-blur)` (always pair with `-webkit-backdrop-filter`).
- **Modals**: overlay `animation: fadeIn 200ms var(--ease-out)` + `backdrop-filter: blur(8px)`; panel `scaleIn 240ms`, `--radius-xl`, `--shadow-xl`.
- **Popovers / menus / dropdowns**: `slideUp 160ms var(--ease-out)` + `--shadow-lg`.
- **Select (下拉选择)**: use `components/common/Select`, never a native `<select>` — the browser's option popup can't be themed, so it renders OS furniture regardless of tokens. The trigger reads as a text input (`--color-bg-surface`, so the settings `--stg-*` remap reaches it); the menu portals to `<body>` like ContextMenu — app chrome by design, which also keeps it clear of `overflow` clipping in drawers. Selected option = accent tint + accent text per the list-item rule. Surfaces with their own input dialect (AI panel inset/mono, lore paper) re-skin the trigger by passing a class **doubled in their own module** (`.x.x { … }`) — 0-2-0 outranks the base class deterministically, where a single class would tie and fall to bundle order.
- **Reusable keyframes** (in `global.css`): `fadeIn`, `scaleIn`, `slideUp`, `slideInRight` — reuse these, don't redefine per component.
- **Selected/active list items**: `--color-accent-tint` fill + `--color-accent` text.

### 设置页色系 (Settings surface — `src/components/settings/**`)

设计稿 04 gives the settings page its **own warm-paper family** — same hues as the workspace but one step lighter (page `#FBF7EE`, inputs `#FFFDF6`, its own sienna `#A9512B`) — and its own heading serif (Source Serif 4 / Noto Serif SC via `--font-serif-settings`). Implementation decisions:

- **Tokens**: the palette lives in `tokens.css` as `--stg-*`, defined per theme. The mockup only specifies light; the night block maps each `--stg-*` role onto the existing night ramp so dark mode follows without a second design pass.
- **One remap, not eighteen restyles**: every settings module consumes the same `--color-*` vocabulary as the rest of the app, so `SettingsPage.module.css` re-points those roles at `--stg-*` **once on `.page`** (custom properties resolve at use time, so the whole subtree — panes, drawers, probe panel — follows). Element-level exceptions that the mapping can't express (kbd 键帽, stat cards `#F7F1E2`, usage bar `#C68B5A`, hint blocks `#F8F2E3`) read their `--stg-*` token directly.
- **Portals escape the remap** on purpose: `ConfirmDialog` renders through `ModalShell`'s portal and keeps the app-wide manuscript palette — a modal is app chrome, not settings furniture.
- **Toggle switch** (`settingsUi.module.css .toggle`, the app's only switch): 42×22 track with a 1px border and a flat 14×14 **square** knob — no radius, no shadow, per 设计稿 04. OFF is a paper inset (`--stg-card-head` / `--stg-border-menu`, knob `--stg-knob`), ON dyes track+border `--stg-accent` with a `--stg-bg-input` knob. `--stg-knob` is the one palette entry the mockup adds for it (`#A99C7F`; night `#8E8271`, picked from the same warm-gray step as `--stg-text-faint` since the mockup is light-only). Native checkboxes in settings get `accent-color: var(--color-sienna)` to match.

### 设定集设计语言 (Lore surfaces — `src/components/lore/**`)

设计稿 03（claude.ai/design 项目 → `03 设定集 Lore`）给设定集一套**索引卡**语汇：网格纸墙上的微旋转硬阴影卡片、六色分类系统、880×760 的成对模态。实现为 `tokens.css` 里的 `--lore-*` 族（per theme；夜间是把每个角色映射到既有夜色阶的推导，设计稿只给了纸色）。

- **分类六色** `--lore-cat-{character,location,item,event,faction,concept}`：分类圆点、实体头像底、候选徽标共用。映射入口是 `src/components/lore/catColor.ts`（墙与详情共用；未知分类 id 哈希进同一调色板，保证跨会话稳定）。**不要**在组件里再写分类→颜色的字典。
- **卡片墙**：墙底 `--lore-wall-bg` + 36px 网格线 `--lore-wall-grid`；索引卡硬阴影三档 `--lore-card-shadow{,-lg,-hover}`（硬偏移阴影是索引卡的"纸感"，不是海拔——不要换成模糊阴影）。卡片微旋转 ±0.4deg 由实体 id 哈希得出，悬停回正。
- **模态外壳**：`#FBF8F0` 面板 + `--color-border` 边 + `--lore-shadow-modal`（0 12px 48px）；footer 一律 `--color-bg-inset`（#F1E8D5）条 = 左侧斜体说明 + 右侧 取消(轻)/次/主 三级按钮。共用外壳类在 `LoreImproveModal.module.css`（Meta/AiHub/ImageGen/FacetAssist 四个模态借用，改类名前先查引用）。880×760 画幅用 `.panelWide`。
- **diff 绿**：AI 新增内容（改写对照的新行、新标签、建议别名、拆分"新条目"注）一律 `--lore-add-bg`/`--lore-add-text`；改写对照的"新增行"判定是**行级包含**（不在原文的非空行），够用即可，不是真 diff。
- **拆分归属色**：保留 `--lore-split-keep` / 新条目 `--lore-split-a`/`-b`（方案卡色块与正文底色一一对应）。
- **待完善黄**：复用 `--color-warning-bg/-text`；特征的"待完善"（auto 模式且无关键词）是**派生态**，不是存储字段——v2 起它以详情行/表单里的一句警示文案出现，不再是徽标。
- **输入底**：lore 模态里的 textarea/编辑器用 `--lore-bg-input`（#FFFDF6），比卡面再亮半步。
- **mono 纪律**：字数、id、置信度、状态计数（`已接受 1 · 待处理 2`）一律 `--font-mono`——与 AI 面板同规。
- **数据模型未接入而按结构落地的部分**（提取器单候选而非多候选管线；特征无版本号）：设计稿的这些区域需要多候选提取与条目版本两套数据；本轮只落结构与空态，接数据时样式已就位。排序下拉（最近编辑▾）与 DRAW FROM 取材开关同理未做。

#### v2 · 条目 = 主词条 + 特征 + 配图（设计稿屏 14/15/16）

设计稿后来加的三屏把知识库条目重述成**三段结构，直接对应磁盘上的三样东西**：`index.md`（主词条）、若干带 frontmatter 的 `*.md`（特征）、`images.md`（配图）。数据模型早就是这样（`LoreFacet` 的 mode/keys/group/priority、`LoreImage.desc`），只是 UI 还按旧稿分栏，所以这一轮是把界面搬到模型上，不是加字段。

- **详情页三栏**（屏 15，`LoreDetail`）：`主词条 320px | 特征 flex | 配图 300px`。取代了旧的 `正文+特征+图集 | 关系 | 出场密度`——关系与出场是上一轮"按结构落地的空态"，v2 稿把它们整个移出了详情页，所以连同密度时间线一起删掉了（要接关系图谱时按新稿重开一栏，不要复活旧空态）。左栏底部的 mono 文件树是这套语汇的锚：作者随时能看见条目在磁盘上长什么样。
- **每一栏自己滚**（屏 15 的三栏结构 = 三个 `flex-shrink:0` 栏首 + 三个 `overflow-y:auto` 主体 + 钉在栏底的落款）：主词条栏也照此拆成 `.indexHead` / `.indexScroll` / `.indexFoot`。**别让栏本身当滚动盒**——`.colIndex` 一度直接 `overflow-y:auto` 且给正文块配了 `min-height:0`，于是 flex 把渲染好的 markdown 压到低于内容高度，而它不裁剪，正文段落被画到 mono 文件树和「AI 编辑助手 / 拆分条目」上（视觉重叠 69px，实测方式：把正文块的 rect 裁到滚动祖先的 client rect 再和落款 rect 求交，肉眼数像素靠不住）。栏首独立钉住还有第二个理由：三栏的 head 在设计稿里是齐平的一条基线，跟着正文滚就散了。
- **注入语义写在每一行上**：常驻 = 3px `--color-sienna` 左边（它总会进上下文）、自动 = `--color-border-strong` 描边徽标、手动 = 灰描边徽标 + `opacity:.75`（要手动点名才进去）。**互斥组不是标签，是一个虚线盒子**：同组只有一条能进上下文，框起来才说得清，组内按 `priority` 降序排、每行显示 `优先级 N · 字数`。
- **特征编辑弹窗**（屏 16，`FacetEditModal`）：640px 单列，字段顺序 名称 / 注入方式 / 触发词 / 互斥组·优先级 / 正文。注入方式是**三行单选**、每行自带"什么时候会注入"的一句话——这句话就是旧版左栏「检索行为」说明卡的替代品，说明贴在选项上比贴在角落有用。左侧的特征列表也一并删了：列表现在是详情页的特征栏（屏 15），弹窗只编辑打开它的那一条。正文右下角 `字数 ≈ tokens`（`estimateTextTokens`，与预检同一把尺）。
- **墙上的卡片**（屏 14，`LoreWall`）：标签行是**特征名**（`◈` 前缀），不再是别名的第二次复读（别名已经在名字下面那行）；卡片底部虚线上一条 `N 特征 · M 配图`。头像在 v2 稿里是方块——全局零圆角，`cardFeatured` 上遗留的三处 `border-radius:50%` 一并去掉。
- **术语**：UI 一律 **特征**（不是"分面"）。i18n 里 `lore.facet.*` 的 key 名保留（磁盘 frontmatter 字段仍叫 `facet`），只有文案改了；三种模式的中文是 自动 / 常驻 / 手动。

#### 类型系统 · 槽位分段与降级（设计稿屏 19–23）

分类可以带一份**类型 schema**（特征槽位 + 配图槽位，数据侧见
[`lore-entry-type-plan.md`](../feature/lore/lore-entry-type-plan.md)）。这五屏的共同前提写在屏 19 自己的
说明里：**面只是归类与提示，注入仍由每条特征自定**。所以这一整套语汇里没有一处颜色表示
「错误」——没有红、没有警告黄，缺口是邀请，降级是陈述。

- **分段基线**：段首是一条基线 `名字 · mono 计数 · 细线 · ＋`（`.slotHead`）。`＋` 直接
  开「新建特征」并预选这一面。未归类段用同一条基线，但名字压到 `--color-text-faint`
  且**没有 ＋**：它不是类型的一部分，往里"新建"没有意义。
- **互斥组盒子留在面内**：同组只有一条会进上下文，这条规则要在同一个视野里说得清；
  一个组的特征分属不同面时，整盒归**第一条**所在的面（互斥的几条本就是同一面）。
- **缺口 = 虚线一行**（`.slotGap`）：面名 + 槽位自己的 hint + 「+ 补上这一面」。只画
  `expected` 的空面；非 expected 的空面**一行都不画**，清单在左栏的 mono 小结里
  （`.coverageNote`，且只在真的缺东西时出现）。
- **类型行**（`.typeLine`，屏 19）：`类型 novel/人物 · 6 特征面 · 3 配图组`。用能力包
  **id** 而不是它的标签——包 id 是作者在设置、profile.json 里到处见到的那个短词，而标签
  （「小说」）挨着分类名读起来像体裁。
- **降级条**（`.degradedBar`，屏 23）：灰点 + 斜体一句 + 「启用 <包>」次级按钮，压在三栏
  之上。只在**孤儿分类**（无启用包声明、但某个未启用的包声明了它）时出现——分类本来就
  没有 schema（用户自建、`custom`）时什么都不显示，因为什么都没丢。中栏退回平铺列表，
  说明改成「平铺列表 · 每条的注入方式、触发词、互斥组照常生效」。
- **预填只在新建**（屏 21）：选中槽位后，仍处中性值的字段按槽位默认值预填，并挂一枚
  diff 绿的「预填」徽标（`.prefillBadge`，与 AI 新增内容同一套 `--lore-add-*`）；作者一
  改动，徽标即消失——那一刻起值归作者。切换槽位时，**未被改动过的**预填值跟着换，已改过
  的不动。这条纪律的文字版就写在表单里那句「只在新建时预填，保存后归你，改动不会回写类型」。
- **配图分组**（屏 22）沿用同一条基线；已有图库靠**编辑描述时的槽位 chips** 归类（设计稿
  只画了每段的 ＋，那只能给新图分组，旧图库会永远卡在未归类）。
- **按设计稿结构落地但有意收敛的**：屏 22 给多图槽位画的 2 列小图网格没有做——那个变体
  省掉了图片描述，而描述正是纯文本模型唯一能读到的东西，为省高度丢信息不值当；配图卡在
  所有段里保持同一种。

#### v2 · AI 流程与进度指示（设计稿屏 08–13/17/18）

设计稿又一轮重画了知识库的全部 AI 流程屏，核心是屏 17「AI 执行进度 · 思维链」给出的**统一进度词汇**。此前六个 lore AI 模态各说各话（三个渐变点 + 轮播文案 / 裸 JSON 流 / 只换按钮文字 / AgentLog），本轮统一为三个积木（`src/components/lore/ai/LoreRunProgress.tsx`）：

- **状态行 `RunStatusLine`**：12px 转圈（`--color-border` 圈 + sienna 顶弧）或 6px 绿点 + 斜体衬线「生成中/完成」+ mono `Ns · X tok`。六个流的节首都用它；完成态保留耗时与 token 数。运行状态的圆（转圈、步骤圆点、绿点）与 AI 面板的 status dot 同属"已批准的圆"清单——其余一律方角。
- **步骤列 `LoreRunSteps`**：**语义步骤**（读取 → 起草 → 交给你确认），不是工具调用回放——16px 圆标（✓ 实底绿 / sienna 描边脉冲 / 灰描边半透明）+ 1×8px 连接线 + 右侧 mono 注记。固定三段、首段即完成是有意的：单发流没有中途信号，步骤列的价值是告诉作者"现在卡在哪一段、最后一段要他出手"。
- **思维链 `ThinkingPanel`**：`--color-bg-stream` 折叠带，头行 `思维链 · 实时流式 · 不入库`；正文斜体衬线 12px/1.8、顶部渐隐、闪烁光标，流式时自动展开+跟滚，结束自动收起（作者手动切换后以作者为准）。**不入库**是承诺：reasoning 只进这块面板，不进任何文件。
- **分工**：走 agent 工具环的两个流（更新条目、特征 AI 助手）的步骤+思维链仍由 `AgentLog` 承担（工具粒度更细），只补状态行；三个流（提取 / 拆分整理 / 主词条补全）用全套。拆分整理后来改成了工具环（一次 `split_facet` 提交一条特征，见 `lib/agent/splitTools.ts`），但仍留在这一档：作者要看的是"拆到第几条了"，不是工具调用回放——所以第二段步骤的 mono 注记挂**已提交的条数**（`概述已提交 · 已提交 3 个特征`），这也是唯一能让中途停止的运行说清自己留下了什么的地方。数据源是现成的：`generateLore`/`splitLore` 本就跑在 runtime 上，把 `onEvent` 穿透出去即得 reasoning 与 token 总量（此前 `onEvent: () => {}` 白白扔掉）；结构化流用 `runStructuredTask.onReasoning`，token 是 `estimateTextTokens` 估算。
- **各模态对齐**（屏号 → 组件）：08 提取 = 分类范围多选 chips（实底 sienna 选中态，至少留一枚，收窄 `generateLore.allowedCategories` 的枚举）；09 更新条目 = 左栏改为**写入目标列表**（主词条 / 各特征 / 虚线 `+ 生成新特征`），GOAL 预设删除（v2 无此栏，指令框仍在），footer 主键 `应用到 <文件>`；**生成新特征**走 `draft_lore_facet` 结构化单发（标题/触发词/注入方式/正文一次成稿，虚线草稿条可改，Apply → `createFacetFile`）——这正是屏 17 演示的那个任务；10 特征助手 = 快捷动作改单行描边 chips（新增 压缩正文；检查互斥组未做，见下），触发词结果多一排 diff 绿 `+词` 预览；11 拆分整理 = 改名 + 头部统计签 `正文 N 字 · M 特征` + 方案卡补「自动」徽标与「触发词」行标 + footer `应用 · 生成 N 条特征`；12 主词条补全 = 改名 + 全量 i18n（原先整页 `isZh ?` 三元）+ 建议概要 diff 绿；13 AI 中心 = 代码 defaultValue 与 locale 对齐（此前两套文案）；18 生成配图 = 斜纹占位卡（`生成中 · Ns`）+ 补上此前不存在的**图库描述**输入（`note` 状态一直有，只是没有 UI）。
- **术语**：主词条的那句话统一叫 **概要**（屏 15 v3 把「摘要·命中即注入」改成了「概要·命中即注入」；`summary` 字段名与 i18n key 不动）。拆分保留段叫 **正文概述**（屏 11 原文）。
- **模型选择在 footer，不在 header**（设计稿 v4 给屏 08/09/11/12/13/18 补画）：六个 lore AI 模态的模型选择统一是 footer 左端的 `ModelPicker`（`lore/ai/ModelPicker.tsx`）——「模型」灰签 + 触发器 + 1px 竖分隔线。触发器与菜单是 **AI 助手同一个 `ModelSelector`**（`components/ai/ModelSelector.tsx` 的受控模式）：搜索、常用/本地/长上下文筛选、按供应商分组、上下文窗口徽标、状态点，一套语汇两处生效；paper 变体给纸面 footer 常显描边 + `min-width 240px / max-width 380px`，`openUp` 向上展开（屏 10 的上拉形态）。**受控实例不碰全局**：本地 modelId 初始取全局 activeModelId，改动不写回（此前所有模态直接改全局 activeModel，一次任务换模型会波及整个应用）；菜单脚注就是「默认跟随全局设置」，⌘M 与 管理供应商 只属于助手头部的全局实例（模态里跳设置会落在遮罩底下）。生成配图的 footer 签叫**出图模型**；提示词模型留在 header（设计稿没画它，但哪一个在起草提示词必须可见）。运行中 `RunStatusLine` 可挂 `model` 小灰签（屏 17 运行头的 `Claude Sonnet 4.5` chip），完成态不重复显示。
- **footer 的让位顺序：斜体说明先换行 → 模型选择器再收窄 → 按钮永不动**。footer 是一条 flex 行：左组（选择器 + 说明）`flex:1 1 auto; min-width:0`，说明 `min-width:0` 吃掉全部压缩，`.picker` `flex-shrink:0`（所以选择器在合法窗口里始终是设计稿的 240 宽，`.triggerPaper` 的 `min-width:168px` 只是更窄宿主的地板），右组 `flex-shrink:0` + 每枚按钮 `white-space:nowrap`。**按钮不让**的理由很具体：中文标签一旦被压到字宽以下会*逐字折行*成「取 消 / 停 止」，那是这条 strip 唯一不能出的错。共用外壳 `.panel` 同时从 680 提到 **760**（`LoreMetaImproveModal`/`FacetAiAssistantModal` 借它；生成配图 inline 720 → 760）：实测 680 时说明要占三行、760 两行，按钮两种宽度下都完整。窗口 `minWidth` 是 900，760 的面板在任何合法尺寸下都放得下。同一条纪律也补给了 `FacetEditModal`（它的主按钮此前只挂 `btnPrimary`、丢了 `btn` 的基础皮，一并补上）。
- **数据模型未接入、本轮有意不做的**：提取多候选与「并入已有条目」（屏 08 的三卡与置信度需要多候选管线）；更新条目的「整体 · 全部特征」目标与「当前文档/全部工作区文档」资料开关（跨文件 agent 写与检索范围开关）；主词条补全的**批量**形态（屏 12 是三条目队列，现实现仍是单条目）；特征助手的「检查互斥组」（单特征作用域拿不到组上下文）与 v2 的沉浸式聊天布局（picker 因此落在 footer 而非 composer 左侧）；屏 17 的**折叠条变体**（嵌在详情页顶部的后台运行需要 store 级运行态，模态内运行用不上）。接这些时样式词汇已就位。

### AI 面板设计语言 (AI surfaces — `src/components/ai/**`)

The AI drawer and every surface it spawns (panels, cards, modals, the inline bubble) follow a scoped **manuscript-ink** dialect of the system, transcribed from the AI-panel mockup in the claude.ai/design project ("Simple AI Writer UI redesign" → `02 AI 面板`). The dark rendition is the binding reference; light values are paper equivalents derived from the same project's paper screens. Everything below is implemented as tokens in `tokens.css` under the `AI 面板设计语言` comment in each theme block.

**Why a dialect**: the panel used to stack card-in-card-in-input (three nested borders); the redesign expresses hierarchy with **background depth + 1px hairlines** instead, so the drawer reads as part of the manuscript rather than as a foreign toolbox.

- **Zero radius** — no `border-radius` anywhere under `src/components/ai/` (and it leaks into AgentLog's two lore-modal consumers). The only rounds are tiny status dots (`border-radius: 50%`) and spinners. (The AI panel pioneered this; 设计稿 01/04 later made zero radius the global rule — see 令牌速查 above.)
- **Surface ladder** (per theme): `--color-bg-stream` (run column, tool lists) → `--color-bg-inset` (headers, footers, inputs, card interiors) → `--color-bg-base` (drawer body) → `--color-bg-raised` (user bubble, send stamp) → `--color-bg-selected` / `--color-bg-accent-wash` (selected 档位 / active chips).
- **Composer send/stop slot (1b/2d 输入框两态)**: one 34px block, three looks — ready = solid `--color-sienna` + `--color-on-accent` ↑ arrow (14px, stroke 2.2); empty = the same block muted (`--color-bg-raised` + `--color-text-hint` arrow, 置灰 not hidden); running = the raised block framed in `--color-border-accent` holding the 11px sienna square — **the ink square means stop, not send** (2d reversed the original TURN-1 stamp-as-send). While running: the composer frame also turns `--color-border-accent` (outranking focus sienna), the footer leads with three 4px squares (`--color-border-accent`/`--color-accent-mid`/`--color-sienna`) + mono `正在生成 · mm:ss` in `--color-accent-mid`, the kbd hint becomes `Esc 停止`, and Enter queues the draft to send when the run settles (manual stop clears the queue). Muted states keep a `--color-border-input` hairline the mockup doesn't show: on paper `--color-bg-raised` is nearly the composer's own bg, and a frameless block vanishes.
- **Ochre ramp** (accent steps, light→deep): `--color-accent-text` → `--color-sienna` → `--color-accent-mid` → `--color-accent-deep` → `--color-border-accent`. `--color-accent-mid` (#B3764A) is the mockup's shared mid tone — 设定/摘要 bar segments, the 正在生成 note — and is **the same hex in both themes** on purpose: on paper it lands within 2 units of the exact midpoint of `--color-sienna`↔`--color-border-accent`, so it is already the middle step there. Mind that in the light theme `--color-accent-deep` collapses onto `--color-sienna` (both #A0522D), so it cannot serve as a *distinct step* from sienna — reach for `--color-accent-mid` when a ramp has to stay legible as steps in both themes.
- **One frame border max** — a component gets at most one `--color-border-panel` frame; interior grouping uses `--color-hairline` rules + 10px uppercase `--color-text-label` section headers (`letter-spacing .18–.24em`). Section head pattern: label + `flex:1` hairline + right-aligned mono metric.
- **No colored left-border cards.** Documented exceptions (semantic marks, not chrome): ConsistencyCheck severity bars (3px), the 2px `--color-border-accent` selection bar on `.targetCard` / chat quote cards, and error boxes' 2px `--color-error-node` rule.
- **Three-font roles**: Spectral (`--font-serif`) for generated/user prose at `--font-size-reading` 15px/1.85 (`--color-text-prose`), titles, task-segment and lore-entity names; Inter Tight (`--font-sans`) for UI labels 11–13px; JetBrains Mono (`--font-mono`) for **every** number, token count, timestamp, model id, cost, kbd hint and file path — no exceptions.
- **档位组 (mono pill group)**: idle `--color-text-dim` + `--color-border-panel`; selected `--color-accent-text` on `--color-bg-selected` with a sienna border (or, in the task segmented control, `inset 0 -2px 0 var(--color-sienna)` — the tab language). A whole group that the current model doesn't support gets `opacity: .38` plus an explanation line, never `display:none`.
- **Chip taxonomy**: active = `--color-bg-accent-wash` + `--color-border-accent` + `--color-accent-text`; neutral = `--color-border-muted` + `--color-text-soft`; excluded/unconfigured = **dashed** `--color-border-muted` + `--color-text-hint` (absence, not error — no strikethrough); sub-agent-ok = `--color-success-text` + `--color-success-border`.
- **Button tiers**: solid sienna + `--color-on-accent` / outline `--color-border-emphasis` + text-primary / outline `--color-border-muted` + text-soft.
- **Checkboxes**: 13px `appearance:none` squares — sienna-filled with an ink check when on, `--color-border-emphasis` outline when off.
- **Timeline (execution log, flat)**: 1px `--color-border-panel` spine, 9px **square** nodes — pending is a `--color-border-muted` outline; completion fills `--color-success` and carries a 7px `--color-on-accent` check (the checkbox glyph sized down — completion shares TaskPanel's progress semantics, not the accent, and reads at a glance against the sienna spinner and the error red); failures fill `--color-error-node` solid with no glyph. The error detail box (`--color-error-surface` + 2px node rule) reads as that node's detail, and an error is stated **once**, on the timeline. Chat turns anchor on 7px squares (settled = sienna, live = `--color-border-accent`).
- **Diff**: mono 12/1.8, del `--color-diff-del-text/-bg`, add `--color-diff-add-text/-bg`.
- **Allocation bars**: context-allocation 10px trough (`--color-bg-inset`, 2px padding + 2px gaps); chat memory bar 6px on `--color-bar-track`; free space is always a visible track segment, and legends use 7px square swatches + mono values.
- **Chat memory bar segments (2c)**: in bar order — 系统+工具 `--color-text-dim` · 摘要 `--color-accent-mid` · 种子 `--color-border-accent` · 注入设定 `--color-success` · 对话 `--color-sienna` · 空余 = the bare track. The two ochres are **steps of the ramp read left to right**: 摘要 takes the mid step and 种子 the deepest, matching 2c's own segment and legend hexes (#B3764A / #6B4B2E) and its explainer line, which draws the 摘要 marker in #B3764A. Bound by **token, not hex** — so on paper, where `--color-border-accent` is #C9966A, 种子 lands *lighter* than 摘要 rather than darker. That inversion is the paper palette doing its job (a dark-theme deep tone is a paper light tone); what has to hold in both themes is that the three ochres stay three separable steps, and they do — closest pair ΔE 12.6 on paper, 13.1 in the dark. They were transposed from the first transcription (摘要 got the deep tone, 种子 a `--color-ctx-chapter` tan that appears nowhere in the mockup) — that token existed only for the mistake and is gone. Nothing in the bar keys off the AiPanel allocation bar's `--color-alloc-*` family; the two bars are separate mockups.
- **Chat memory bar warning state (2c)**: the warning keys on **crossing the compaction mark** (`willCompact`, 70% of the input ceiling — `COMPACT_TRIGGER`), *not* on the bar being packed full — the mark the bar itself draws *is* the trigger, and warning only at 100% let the bar stand past its own line while looking calm. Warned: frame `--color-warning`, conversation segment recolors to `--color-error-node` (that is the part compaction will fold), used-count recolors to `--color-error-text-strong`. The 归纳 explainer line renders only with the legend open while warned — permanent chrome above the input costs message space on every session. Known softness: in the light theme `--color-warning` shares its hex with the 种子 segment (`--color-border-accent`, both #C9966A) — accepted for now rather than minting a token for one state.
- **执行日志 truncation & round-cap rows (2a)**: the 已截断 badge is driven by the runtime's `argsTruncated`/`resultTruncated` flags recorded at the slice site (`ToolStep`); the length heuristic survives only as the fallback for sessions persisted before the flags — it mis-fires on pretty-printed args, which is why it stopped being the primary. `round-limit` rows render as a standalone muted line closing band ② (after the round accordion), never inside a round body: the event happens *between* rounds and punctuates the accordion as a whole. `context-compacted` rows deliberately stay inside the round they preceded — the mockup shows 已归纳 as a row within a round body, and which round it sits in is simply when compaction fired.
- **Sent-message references (2b)**: `@[名称]` tokens in a sent user bubble render in the ref-chip accent (`--color-accent-text`) via `lib/agent/mentionText.splitMentions` — the bubble is the record of the composition the chips described. Only tokens the picker could have spliced count (`@[` + bracket-free, newline-free label + `]`); anything else stays plain text. The chat composer's mention picker anchors **above** the input (`preferAbove` — the composer sits at the panel's bottom edge); lore modals keep below-first.
- **Known deltas from the global rules**: the drawer is **opaque ink** (`--color-bg-base`), not glass — the hairline hierarchy would be muddied by blur; depth inside the panel comes from background steps and borders, with shadows only on true overlays (分层海拔 applies to overlays only here); TaskPanel's done-pips are success green (progress semantics), not accent tint.

### 提示词库 (Snippet library — the picker, the save menu, 设置 → Prompt)

Transcribed from 设计稿 `10 提示词库 Snippets`. Two halves that must not drift apart, plus one page that files them.

- **取用侧 = the model selector's structure, one for one.** Search row → filter chips → sectioned list → footer, at 520px wide / 480px max height, opening **upward** (it lives at the bottom of a full-height drawer). Row padding is 9/13 — the same as the `@` mention picker, deliberately. Colours are the existing families plus a small `--snip-*` set (`--snip-rule` · `--snip-row-hover` · `--snip-hit-bg` · `--snip-preview` · `--snip-shadow` · `--snip-menu-shadow`) defined in **both** theme blocks; light is not dark with a swapped ground (`#A9512B` rule, `#F3EBD9` hover, preview two tiers down, an upward *warm brown* shadow).
- **选中 ≠ 悬停, and both can be on screen at once.** The keyboard cursor is `inset 2px 0 0 var(--snip-rule)` and **fills nothing**; hover is a neutral `--snip-row-hover` fill and draws **no** rule. Tinting hover with the accent is exactly what makes the two unreadable together. The cursor row's left padding drops 15→13 so the rule eats the padding instead of shifting the text.
- **≤ 5 snippets: no search box, no chips, no section headers.** Three rows that still demand a search box is ceremony added to a list. The threshold is `SIMPLE_MAX` in `lib/ai/snippets.ts`.
- **Sections are groups, chips are a filter.** A snippet has **one** `group` (not tags) — that is what lets the picker reuse the section list without spending the chip row on the organising axis. `未分组` is an inbox, not a category: it renders last in the picker (one tier fainter), **first** in Settings, and is where every right-click save lands. `常用` = the five most recently used and is **not** de-duplicated against the group sections — a row appearing twice is cheaper than "the one I just used vanished".
- **保存侧 = the app's own context menu, carrying the clipboard.** The three composers are bare `<textarea>`s, so their right-click *is* the OS clipboard menu; replacing it obliges us to ship 剪切／复制／粘贴／全选 and hang 存为片段 under a divider. On a message bubble the list becomes what is possible there (no cut/paste; 全选 → 复制整条 → 引用到输入框). With no selection the item saves the **whole box** rather than greying out — only an empty box disables it, and the grey count on the right says which is about to happen.
- **命名 replaces the menu in place** — same coordinates, 320px, one field, name pre-filled from the body and pre-selected, ⏎ saves. No group picker at save time: the author's attention is on the sentence being written.
- **确认 is a hairline and a word, never a toast.** An accent `inset 0 -1px 0` under the snippet entry plus `+1 已存入「未分组」` (1.6s) or `已插入「名字」` (2.4s), both offering ⌘Z. It lives in `components/ai/snippetTrace.ts` — a module-level emitter rather than a store, because a fading timer has no business re-rendering every subscriber of the prompt list.
- **插入永远追加到末尾并换行** (`appendSnippet`), never following the caret and never touching the selection; the box keeps focus and scrolls to the end. And it **never sends** — a snippet is an opening the author completes.
- **`{{…}}` is literal text.** No substitution engine, no tab stops, no variable syntax: a 1px dashed underline and one tier brighter, enough to spot and little enough that it still reads as prose you can select and delete.
- **主题覆盖是有测试守着的**, because the failure mode is silent: `tokens.css` has three blocks (`:root` + one per theme) and several section comments appear in more than one of them, so a family appended next to "the" anchor can land in the wrong theme and override the values it was meant to complement. `themeTokenParity.test.ts` pins two things — every custom property is either in `:root` or in **both** theme blocks, and the snippet surfaces (plus the shared `ContextMenu` they borrow) contain **no** raw hex/rgba at all. After adding any `--x-*` family, also read it back in the running app per theme: `getComputedStyle(document.documentElement).getPropertyValue('--x-…')`. Screenshots do not show this.
- **设置 → Prompt is one page with two regions, not two tabs.** Tabs would set "my sticky notes" and "rewrite the instruction every call carries" side by side as peers. The library owns the page; overrides are a collapsed strip at the foot. "More dangerous" is built from five things and **no second colour**: position, the collapse, a box around the whole region, a grey band stating the consequence, a 2px accent bar on only the overridden entries, and a forced side-by-side of your version against the built-in default. The row dot is one of the app's sanctioned circles — filled = overridden, hollow = default.

### 禁止 (Do NOT)
- Hardcode `rgba(…)` accent tints or `box-shadow: 0 …` — use tokens.
- Use gradient backgrounds on buttons/badges/active states.
- Add focus styles that only change `border-color` (use `:focus-visible` ring).
- Reach for a JS animation library for element-level motion — hover/press/enter accents stay **pure CSS** (tokens + keyframes) to stay lightweight.

### 例外 · 转场与浮层 (Exception — transitions & overlays)
**Motion** (`motion`, ex-`framer-motion`) is the one sanctioned JS animation library, used **solely** where a surface must animate *out* while another animates *in* — something CSS mount-only animations can't do. Two uses only:
- **Screen / content switches** — `App.tsx` (main view crossfade/slide), `Sidebar.tsx` (tab crossfade), `LoreWall.tsx` (grid↔detail push), `AiPanel.tsx` (task/instruction config crossfade, `mode="wait"` keyed by selected task).
- **Overlay enter *and* exit** — `AiDrawer.tsx` (drawer slide-over), `SettingsPage.tsx` (settings). Each pairs with `<AnimatePresence>` so dismissal animates instead of snapping; the old mount-only CSS `animation:` on those `.backdrop`/`.overlay`/`.drawer`/`.palette`/`.modal` classes was removed in favor of these. `CommandPalette.tsx` is a decision change from this: it is a keyboard-triggered, high-frequency surface, so it is deliberately zero-animation (except an 80ms scrim fade-in).

**Watch the containing block.** While a `motion` element is animating it carries a `transform`, and a transform makes the element a containing block for `position: fixed` descendants — a context menu or modal rendered inside a transitioning subtree will sit in the wrong place for the length of the transition. Motion resets `transform` to `none` at rest, so this is transient, but don't add an overlay that must stay usable *during* a transition without checking it.

Presets live in `src/lib/motion.ts` (`springScreen`/`springPanel`/`springDrawer`, `viewSlide`, `pushForward`/`pushBackdrop`, `panelFade`, `overlayFade`, `drawerSlide`, `modalPop`, `fillLayer`). `<MotionConfig reducedMotion="user">` at the app root keeps every transition honoring `prefers-reduced-motion` — keep it there. Do **not** spread Motion into buttons, hovers, list items, or other element-level motion; those remain pure CSS keyframes. New modals that don't need a custom exit can still use the plain `scaleIn`/`fadeIn` keyframes.

**Theme (light/dark) crossfade** is *not* Motion — it uses the native **View Transitions API** (`document.startViewTransition`) in `appStore.applyThemeAnimated`, so the whole UI cross-dissolves on a theme flip (CSS vars change instantly, so only a full-page snapshot can crossfade everything). Timing is tuned via `::view-transition-old/new(root)` in `global.css`; it no-ops on webviews without the API and is skipped under `prefers-reduced-motion`.
