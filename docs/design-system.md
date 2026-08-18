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
- **注入语义写在每一行上**：常驻 = 3px `--color-sienna` 左边（它总会进上下文）、自动 = `--color-border-strong` 描边徽标、手动 = 灰描边徽标 + `opacity:.75`（要手动点名才进去）。**互斥组不是标签，是一个虚线盒子**：同组只有一条能进上下文，框起来才说得清，组内按 `priority` 降序排、每行显示 `优先级 N · 字数`。
- **特征编辑弹窗**（屏 16，`FacetEditModal`）：640px 单列，字段顺序 名称 / 注入方式 / 触发词 / 互斥组·优先级 / 正文。注入方式是**三行单选**、每行自带"什么时候会注入"的一句话——这句话就是旧版左栏「检索行为」说明卡的替代品，说明贴在选项上比贴在角落有用。左侧的特征列表也一并删了：列表现在是详情页的特征栏（屏 15），弹窗只编辑打开它的那一条。正文右下角 `字数 ≈ tokens`（`estimateTextTokens`，与预检同一把尺）。
- **墙上的卡片**（屏 14，`LoreWall`）：标签行是**特征名**（`◈` 前缀），不再是别名的第二次复读（别名已经在名字下面那行）；卡片底部虚线上一条 `N 特征 · M 配图`。头像在 v2 稿里是方块——全局零圆角，`cardFeatured` 上遗留的三处 `border-radius:50%` 一并去掉。
- **术语**：UI 一律 **特征**（不是"分面"）。i18n 里 `lore.facet.*` 的 key 名保留（磁盘 frontmatter 字段仍叫 `facet`），只有文案改了；三种模式的中文是 自动 / 常驻 / 手动。

### AI 面板设计语言 (AI surfaces — `src/components/ai/**`)

The AI drawer and every surface it spawns (panels, cards, modals, the inline bubble) follow a scoped **manuscript-ink** dialect of the system, transcribed from the AI-panel mockup in the claude.ai/design project ("Simple AI Writer UI redesign" → `02 AI 面板`). The dark rendition is the binding reference; light values are paper equivalents derived from the same project's paper screens. Everything below is implemented as tokens in `tokens.css` under the `AI 面板设计语言` comment in each theme block.

**Why a dialect**: the panel used to stack card-in-card-in-input (three nested borders); the redesign expresses hierarchy with **background depth + 1px hairlines** instead, so the drawer reads as part of the manuscript rather than as a foreign toolbox.

- **Zero radius** — no `border-radius` anywhere under `src/components/ai/` (and it leaks into AgentLog's two lore-modal consumers). The only rounds are tiny status dots (`border-radius: 50%`) and spinners. (The AI panel pioneered this; 设计稿 01/04 later made zero radius the global rule — see 令牌速查 above.)
- **Surface ladder** (per theme): `--color-bg-stream` (run column, tool lists) → `--color-bg-inset` (headers, footers, inputs, card interiors) → `--color-bg-base` (drawer body) → `--color-bg-raised` (user bubble, send stamp) → `--color-bg-selected` / `--color-bg-accent-wash` (selected 档位 / active chips).
- **Composer send/stop slot (1b/2d 输入框两态)**: one 34px block, three looks — ready = solid `--color-sienna` + `--color-on-accent` ↑ arrow (14px, stroke 2.2); empty = the same block muted (`--color-bg-raised` + `--color-text-hint` arrow, 置灰 not hidden); running = the raised block framed in `--color-border-accent` holding the 11px sienna square — **the ink square means stop, not send** (2d reversed the original TURN-1 stamp-as-send). While running: the composer frame also turns `--color-border-accent` (outranking focus sienna), the footer leads with three 4px squares (`--color-border-accent`/`--color-accent-deep`/`--color-sienna`) + mono `正在生成 · mm:ss` in `--color-accent-deep` (mockup's #B3764A has no general token — accepted nearest), the kbd hint becomes `Esc 停止`, and Enter queues the draft to send when the run settles (manual stop clears the queue). Muted states keep a `--color-border-input` hairline the mockup doesn't show: on paper `--color-bg-raised` is nearly the composer's own bg, and a frameless block vanishes.
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
- **Chat memory bar warning state (2c)**: the warning keys on **crossing the compaction mark** (`willCompact`, 70% of the input ceiling — `COMPACT_TRIGGER`), *not* on the bar being packed full — the mark the bar itself draws *is* the trigger, and warning only at 100% let the bar stand past its own line while looking calm. Warned: frame `--color-warning`, conversation segment recolors to `--color-error-node` (that is the part compaction will fold), used-count recolors to `--color-error-text-strong`. The 归纳 explainer line renders only with the legend open while warned — permanent chrome above the input costs message space on every session. Known softness: in the light theme `--color-warning` shares its hex with the 种子 segment (`--color-ctx-chapter`) — accepted for now rather than minting a token for one state.
- **执行日志 truncation & round-cap rows (2a)**: the 已截断 badge is driven by the runtime's `argsTruncated`/`resultTruncated` flags recorded at the slice site (`ToolStep`); the length heuristic survives only as the fallback for sessions persisted before the flags — it mis-fires on pretty-printed args, which is why it stopped being the primary. `round-limit` rows render as a standalone muted line closing band ② (after the round accordion), never inside a round body: the event happens *between* rounds and punctuates the accordion as a whole. `context-compacted` rows deliberately stay inside the round they preceded — the mockup shows 已归纳 as a row within a round body, and which round it sits in is simply when compaction fired.
- **Sent-message references (2b)**: `@[名称]` tokens in a sent user bubble render in the ref-chip accent (`--color-accent-text`) via `lib/agent/mentionText.splitMentions` — the bubble is the record of the composition the chips described. Only tokens the picker could have spliced count (`@[` + bracket-free, newline-free label + `]`); anything else stays plain text. The chat composer's mention picker anchors **above** the input (`preferAbove` — the composer sits at the panel's bottom edge); lore modals keep below-first.
- **Known deltas from the global rules**: the drawer is **opaque ink** (`--color-bg-base`), not glass — the hairline hierarchy would be muddied by blur; depth inside the panel comes from background steps and borders, with shadows only on true overlays (分层海拔 applies to overlays only here); TaskPanel's done-pips are success green (progress semantics), not accent tint.

### 禁止 (Do NOT)
- Hardcode `rgba(…)` accent tints or `box-shadow: 0 …` — use tokens.
- Use gradient backgrounds on buttons/badges/active states.
- Add focus styles that only change `border-color` (use `:focus-visible` ring).
- Reach for a JS animation library for element-level motion — hover/press/enter accents stay **pure CSS** (tokens + keyframes) to stay lightweight.

### 例外 · 转场与浮层 (Exception — transitions & overlays)
**Motion** (`motion`, ex-`framer-motion`) is the one sanctioned JS animation library, used **solely** where a surface must animate *out* while another animates *in* — something CSS mount-only animations can't do. Two uses only:
- **Screen / content switches** — `App.tsx` (main view crossfade/slide), `Sidebar.tsx` (tab crossfade), `LoreWall.tsx` (grid↔detail push), `AiPanel.tsx` (task/instruction config crossfade, `mode="wait"` keyed by selected task).
- **Overlay enter *and* exit** — `AiDrawer.tsx` (drawer slide-over), `CommandPalette.tsx` (search palette), `SettingsPage.tsx` (settings). Each pairs with `<AnimatePresence>` so dismissal animates instead of snapping; the old mount-only CSS `animation:` on those `.backdrop`/`.overlay`/`.drawer`/`.palette`/`.modal` classes was removed in favor of these.

**Watch the containing block.** While a `motion` element is animating it carries a `transform`, and a transform makes the element a containing block for `position: fixed` descendants — a context menu or modal rendered inside a transitioning subtree will sit in the wrong place for the length of the transition. Motion resets `transform` to `none` at rest, so this is transient, but don't add an overlay that must stay usable *during* a transition without checking it.

Presets live in `src/lib/motion.ts` (`springScreen`/`springPanel`/`springDrawer`, `viewSlide`, `pushForward`/`pushBackdrop`, `panelFade`, `overlayFade`, `drawerSlide`, `modalPop`, `fillLayer`). `<MotionConfig reducedMotion="user">` at the app root keeps every transition honoring `prefers-reduced-motion` — keep it there. Do **not** spread Motion into buttons, hovers, list items, or other element-level motion; those remain pure CSS keyframes. New modals that don't need a custom exit can still use the plain `scaleIn`/`fadeIn` keyframes.

**Theme (light/dark) crossfade** is *not* Motion — it uses the native **View Transitions API** (`document.startViewTransition`) in `appStore.applyThemeAnimated`, so the whole UI cross-dissolves on a theme flip (CSS vars change instantly, so only a full-page snapshot can crossfade everything). Timing is tuned via `::view-transition-old/new(root)` in `global.css`; it no-ops on webviews without the API and is skipped under `prefers-reduced-motion`.
