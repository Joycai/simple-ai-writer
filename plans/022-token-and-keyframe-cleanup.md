# 022 — 令牌归位与关键帧去重（005 的漏网之鱼）

- **Status**: TODO
- **Commit**: 93eb7de
- **Severity**: LOW
- **Category**: 内聚与令牌 / 性能
- **Estimated scope**: 4 个 CSS 文件，6 处改动

## Problem

方案 005（DONE，基准 0f49132）把当时全库的手写缓动值和非合成属性动画清了一遍。
此后新增的代码没有接上同一批约定，攒出六处同类问题。逐条列出现状：

**A. 手写 `cubic-bezier` 复刻 `--ease-out`**（`tokens.css:52` 就是这个值）：

```css
/* src/components/ai/SnippetPicker.module.css:106 — 现状 */
  animation: snipRise 160ms cubic-bezier(0.32, 0.72, 0, 1);
```
```css
/* src/components/ai/SnippetSaveMenu.module.css:20 — 现状 */
  animation: nameIn 160ms cubic-bezier(0.32, 0.72, 0, 1);
```

**B. `fadeIn` 的两个逐字克隆。** `global.css:51-54` 的 `fadeIn` 就是
`from{opacity:0} to{opacity:1}`，下面两个关键帧一字不差：

```css
/* src/components/ai/SnippetSaveMenu.module.css:22 — 现状 */
@keyframes nameIn { from { opacity: 0; } to { opacity: 1; } }
```
```css
/* src/components/ai/SnippetPicker.module.css:86 — 现状 */
@keyframes traceIn { from { opacity: 0; } to { opacity: 1; } }
/* 用在 :67 —  .trace { animation: traceIn 240ms var(--ease-out); } */
```

**C. `slideInRight` 的近似克隆 + 冗余的令牌回退**：

```css
/* src/components/settings/panes/DocFormat.module.css:382,385-388 — 现状 */
  animation: drawerIn 220ms var(--ease-out, cubic-bezier(0.32, 0.72, 0, 1));
}
@keyframes drawerIn {
  from { transform: translateX(18px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
```
`--ease-out` 是 `:root` 上无条件定义的，回退分支永远走不到——它只是把方案 005
要清的那个手写值又写了一遍。而 `drawerIn` 与 `global.css:63-66` 的 `slideInRight`
（`translateX(24px)` + 同样的 opacity）结构完全相同，只差 6px。

**D. 同款控件两个时长。** 方案 005 把文件树的折叠箭头统一到 120ms
（`FileTree.module.css:165`，理由写在 005 里：文件树展开是 100+ 次/天）。设置页
里的同款折叠箭头是另一个数：

```css
/* src/components/settings/panes/Prompts.module.css:235 — 现状 */
  transition: transform 200ms var(--ease-out);
}
.ovChevronOpen { transform: rotate(90deg); }
```
200ms 既没走令牌（`--transition-base` 就是 200ms），也和同款控件不一致。

**E. 动画 `border-width`（非合成属性）+ 裸 `ease`**：

```css
/* src/components/settings/panes/DocFormat.module.css:96-116 — 现状 */
.radio {
  width: 13px; height: 13px; margin-top: 4px;
  border-radius: var(--radius-round);
  border: 1px solid var(--stg-border-menu);
  background: var(--stg-bg-input);
  box-sizing: border-box;
  padding: 0; cursor: pointer;
  transition: border-width 120ms ease, border-color 120ms ease;
}
.radioOn,
.radioOn:hover {
  border: 4px solid var(--stg-accent);
  background: var(--stg-bg-input);
}
```
`border-width` 触发布局，`ease` 是被令牌取代掉的内建曲线。这正是方案 005 的
A 项（开关旋钮动画 `left`）同一类病灶，只是这个控件是后来加的。

## Target

**A**：

```css
/* SnippetPicker.module.css:106 — 目标 */
  animation: snipRise 160ms var(--ease-out);
/* SnippetSaveMenu.module.css:20 — 目标（同时并入 B） */
  animation: fadeIn 160ms var(--ease-out);
```

**B**：删掉 `@keyframes nameIn` 与 `@keyframes traceIn` 两条定义，引用改成 `fadeIn`：

```css
/* SnippetPicker.module.css:67 — 目标 */
  animation: fadeIn 240ms var(--ease-out);
```

**C**：

```css
/* DocFormat.module.css:382 — 目标 */
  animation: slideInRight 220ms var(--ease-out);
```
连同删掉 `@keyframes drawerIn`（:385-388）。**这一项会让抽屉的滑入距离从 18px
变成 24px**，是本方案唯一一处肉眼可见的变化，收益是这个抽屉从此与全应用其余
右侧滑入共用同一段位移。Verification 里有对应的核验步骤。

**D**：

```css
/* Prompts.module.css:235 — 目标 */
  transition: transform var(--transition-fast);
```

**E**：厚边框改成**内阴影**画同一个圈——`box-shadow` 只重绘、不布局，且可插值。
几何完全等价：13px border-box，1px 边框 → padding box 11px，内阴影从 padding box
边缘再吃 3px，赭石总厚度 1+3 = 4px，中心留 5px 底色，与原来的
`border: 4px` 逐像素相同（`border-radius` 是 `--radius-round`，内阴影跟随圆角）。

```css
/* DocFormat.module.css — 目标 */
.radio {
  width: 13px; height: 13px; margin-top: 4px;
  border-radius: var(--radius-round);
  border: 1px solid var(--stg-border-menu);
  background: var(--stg-bg-input);
  box-sizing: border-box;
  padding: 0; cursor: pointer;
  /* 选中态用内阴影加厚而不是加粗边框：border-width 会触发布局，box-shadow 只
     重绘。1px 边 + 3px 内阴影 = 原来的 4px 边，几何一致。 */
  transition: box-shadow var(--transition-fast), border-color var(--transition-fast);
}

.radio:hover { border-color: var(--stg-accent-soft); }

.radioOn,
.radioOn:hover {
  border-color: var(--stg-accent);
  box-shadow: inset 0 0 0 3px var(--stg-accent);
}
```

## Repo conventions to follow

- 令牌：`src/styles/tokens.css:51-54` —
  `--ease-out: cubic-bezier(0.32, 0.72, 0, 1);`、`--transition-fast: 120ms var(--ease-out);`。
  tokens.css 首行：**All UI reads from these vars, never raw values.**
- 共享关键帧：`src/styles/global.css:51-70` 的 `fadeIn` / `scaleIn` / `slideUp` /
  `slideInRight` / `dropIn` / `riseIn`。design-system.md:78 明写「**Reusable
  keyframes**（in `global.css`）：reuse these, don't redefine per component」。
- 同类修法的样板：`plans/005-composite-props-and-tokens.md` 的 A 项（`left` →
  `transform`）与 D 项（`130ms ease` → `var(--transition-fast)`）。
- 模块内保留自己的 `@keyframes` 是**允许**的（`snipRise` / `writerPulse` /
  `shimmer` / `transitionGrow` 都是单点专用动画，留着）；本方案只删**语义上是
  global.css 已有动画的克隆**那三个。

## Steps

1. `src/components/ai/SnippetPicker.module.css`
   - :67 `animation: traceIn 240ms var(--ease-out);` → `animation: fadeIn 240ms var(--ease-out);`
   - :86 删掉整行 `@keyframes traceIn { … }`
   - :106 `cubic-bezier(0.32, 0.72, 0, 1)` → `var(--ease-out)`（**保留** `snipRise`）
2. `src/components/ai/SnippetSaveMenu.module.css`
   - :20 `animation: nameIn 160ms cubic-bezier(0.32, 0.72, 0, 1);` → `animation: fadeIn 160ms var(--ease-out);`
   - :22 删掉整行 `@keyframes nameIn { … }`
3. `src/components/settings/panes/Prompts.module.css`
   - :235 `transition: transform 200ms var(--ease-out);` → `transition: transform var(--transition-fast);`
4. `src/components/settings/panes/DocFormat.module.css`
   - :382 `animation: drawerIn 220ms var(--ease-out, cubic-bezier(0.32, 0.72, 0, 1));` → `animation: slideInRight 220ms var(--ease-out);`
   - :385-388 删掉 `@keyframes drawerIn { … }` 整块
   - :96-116 按 Target E 替换 `.radio` 的 `transition` 行与 `.radioOn` 块
     （`.radio:hover` 那行不动）
5. 复查：`grep -rn "cubic-bezier" src --include="*.css" | grep -v tokens.css` 应当
   **零输出**。

## Boundaries

- **不动 `src/styles/global.css`**——本方案只消费它已有的关键帧，一个都不加、
  不改、不删。
- 不动 `@keyframes snipRise` / `writerPulse` / `shimmer` / `transitionGrow` /
  `orderFlash` / `slideOutRight` / `jumpLatestIn`——它们不是克隆，各有各的位移或
  节奏。
- 不改任何颜色、尺寸、间距值。E 项**只**把 `border: 4px solid X` 拆成
  `border-color: X` + `inset box-shadow 3px X`，视觉终态必须逐像素不变。
- 不改 `.rowSelected .radioCol { width: 30px; }`（:94）——那是选中行的列宽，
  与单选点无关。
- 不动 `DocFormat.module.css:390-392` 的 `prefers-reduced-motion` 块
  （`.drawer { animation: none; }`）——它按类名生效，换了关键帧名依然对。
- 不引入新令牌、不新增依赖。
- 若某行与摘录不符（相对 93eb7de 有漂移），停下报告该处，其余照常。

## Verification

- **机械**：
  - `pnpm build` 通过。
  - `grep -rn "cubic-bezier" src --include="*.css" | grep -v tokens.css` → 零输出。
  - `grep -rn "keyframes nameIn\|keyframes traceIn\|keyframes drawerIn" src` → 零输出。
  - `grep -rn "border-width" src --include="*.css"` → 不再出现在 `transition:` 里。
  - 若方案 019 已落地：`pnpm test src/lib/__tests__/cssKeyframeNames.test.ts` 通过
    （删掉三个克隆定义后，`fadeIn`/`slideInRight` 的引用必须仍然找得到定义——
    这正是那条断言的用处）。
- **感觉核验**（`pnpm dev`）：
  - **A/B**：AI 面板右下角打开提示词库（`SnippetPicker`）——弹层仍然从下往上
    弹起、曲线与改前**无法分辨**（改的只是写法）。右键存入片段后，条目下方的
    确认痕迹（`.trace`）仍然淡入。
  - **C**：设置 → 文档格式 → 打开右侧编辑抽屉。抽屉从右滑入，**位移比改前略长
    （18px → 24px）**，这是预期。对照另一个右侧滑入表面
    （设置 → 供应商与模型 的抽屉，`ProvidersModels.module.css:454` 用的就是
    `slideInRight`）确认两者现在观感一致。若并排看下来这一改反而变突兀，
    **停下报告**，不要自行折中成 20px。
  - **D**：设置 → Prompt，反复点开/收起折叠项。箭头旋转应当与文件树的折叠箭头
    **同速**（两个都开着对比一次）。
  - **E**：设置 → 文档格式，在几个「设为默认」单选点之间来回点。
    - 选中圈的**尺寸、粗细、圆角、颜色**必须与改前逐像素一致——截图对比，
      或用 DevTools 量 `getBoundingClientRect()`（13×13 不许变）。
    - 在 DevTools → Animations 面板把速度调到 10% 再点一次：赭石圈应当**厚度
      渐变**着长出来，且这一次**不再触发 Layout**（Performance 面板录一小段，
      确认点击时只有 Paint，没有 Layout）。
  - 全程打开 Rendering → Emulate `prefers-reduced-motion: reduce` 再走一遍
    A–E：所有入场应当由全局兜底冻结、所有终态仍然正确显示。
- **Done when**：五处 grep 全部清零；抽屉与供应商抽屉观感一致；单选点终态逐像素
  不变且点击不再触发 Layout。
