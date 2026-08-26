# 015 — 右键菜单入场：006 漏掉的最后一个锚定弹出层

- **Status**: DONE (2026-08-23 落地；2026-08-26 复核生效)。曾因「阻断 A · keyframe 作用域」不生效，该阻断已随 `vite.config.ts` 切 LightningCSS 解决——2026-08-26 核对构建产物确认本方案的动画引用已命中定义、真的在播。本方案无需再改
- **Commit**: 78160c2
- **Severity**: MEDIUM
- **Category**: 物理性与出场方向 / 一致性
- **Estimated scope**: 1 个 CSS 文件，2 行

## Problem

方案 006 把「触发器锚定的弹出层从锚点长出来」这条规则落到了五个表面（Select、AiDrawer 会话菜单、ModelSelector、ReasoningControls、AttachmentTextarea），并为此在 `global.css` 新增了 `dropIn` / `riseIn` 两个共享帧。**`ContextMenu` 不在那份清单里**——它是全应用唯一一个既无入场动画、也无 `transform-origin` 的锚定弹出层，而它恰恰是复用度最高的一个底盘：

```css
/* src/components/common/ContextMenu.module.css:7-14 — 现状 */
.menu {
  position: fixed;
  min-width: 176px;
  padding: 5px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-strong);
  box-shadow: var(--shadow-lg);
}
```

八个调用点共用它，右键菜单与下拉菜单因此说着两种话：

- `src/components/layout/FileTree.tsx:27`（文件树右键）
- `src/components/editor/EditorContextMenu.tsx:22`（编辑器右键）
- `src/components/layout/ExportMenu.tsx:17`（标题栏导出下拉）
- `src/components/lore/LoreWall.tsx:32`、`src/components/lore/LoreDetail.tsx:55`
- `src/components/library/LibraryView.tsx:16`
- `src/components/ai/SnippetPicker.tsx:17`、`src/components/common/MarkdownTextarea.tsx:19`

`global.css:84-89` 的注释已经把答案写好了，只是没人接：

```css
/* src/styles/global.css:84-89 — 已存在 */
/* 触发器锚定的弹出层入场：下挂用 dropIn（从触发器落下），上挂用 riseIn。
   配合各自的 transform-origin 使用。 */
@keyframes dropIn {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}
```

**为什么这一处不适用方案 003 的「删掉入场动画」结论**：003 删的三个表面（查找栏、`@` 提及选择器、AI 气泡）都因为组件 `return null` 而在**每次按键或每次选区变化时重新 mount、把关键帧从零重放**——那是键盘高频路径。`ContextMenu` 由一次明确的右键点击打开、由一次明确的点击或 Escape 关闭，使用期间不重挂载，频率是「偶尔」档。两者不是同一类问题。

## Target

`.menu` 追加与 `ModelSelector.popover` 完全一致的一对属性：

```css
/* src/components/common/ContextMenu.module.css — 目标 */
.menu {
  position: fixed;
  min-width: 176px;
  padding: 5px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-strong);
  box-shadow: var(--shadow-lg);
  animation: dropIn 140ms var(--ease-out);
  transform-origin: top left;
}
```

**不需要 `riseIn` 对应物，也不要加。** `ContextMenu.tsx:38-40` 只做视口钳制、从不翻转方向：

```tsx
// src/components/common/ContextMenu.tsx:38-40 — 现状（只钳制，不翻转）
  const height = items.reduce((h, it) => h + (it.kind === "divider" ? 9 : 30), 10);
  const left = Math.min(x, window.innerWidth - 204);
  const top = Math.min(y, window.innerHeight - height - 8);
```

菜单永远从锚点向右下方展开（贴边时整体上移，但仍是向下展开的一块），所以 `top left` 无条件正确。给它加 `.menuUp` 是无用代码。

时长取 **140ms**（与 `ModelSelector.module.css:140` 同值，是仓库两个既有值 140/160 中较短的那个）：右键菜单直接出现在光标底下、位移为零，是所有锚定弹出层里最该快的一个。仍在下拉菜单 150–250ms 预算的合理下沿。

## Repo conventions to follow

- 共享帧住 `src/styles/global.css`；模块引用本文件未声明的动画名会透传到全局（先例：`AiDrawer.module.css:115` 引用全局 `dropIn`）。**不要**在 `ContextMenu.module.css` 里本地重声明 `dropIn`——方案 006 刚清掉过两组这样的克隆帧。
- 精确照抄的范本：`src/components/ai/ModelSelector.module.css:140-141`

```css
  animation: dropIn 140ms var(--ease-out);
  transform-origin: top left;
```

- reduced-motion 由 `global.css:122` 的全局兜底统一归零，**不要**在本模块新增 `@media (prefers-reduced-motion)` 块（这个菜单不承担「还活着」的信号，归零是对的；`AgentChat.module.css:550` 那种本地反压只给加载指示用）。

## Steps

1. `src/components/common/ContextMenu.module.css`：在 `.menu` 规则的 `box-shadow` 行之后追加两行：
   ```css
   animation: dropIn 140ms var(--ease-out);
   transform-origin: top left;
   ```
   规则内其余声明一律不动。

## Boundaries

- 只改 `.menu` 一条规则。不动 `.overlay`、`.item`、`.itemDanger`、`.divider`。
- 不动 `ContextMenu.tsx` 的任何代码——定位、钳制、事件、portal 全部保持原样。
- 不新增 `.menuUp` 或任何方向变体。
- 不在本模块声明 `@keyframes`。
- 不动 `global.css`。
- 不碰八个调用点中的任何一个。
- 若 `.menu` 规则内容与上文摘录不符（相对 78160c2 有漂移），停下报告，不要凭猜改。

## Verification

- **Mechanical**:
  - `pnpm tsc --noEmit` 通过（本方案不含 TS 改动，只作回归确认）。
  - `pnpm build` 通过。
  - `grep -n "@keyframes" src/components/common/ContextMenu.module.css` **零命中**（确认没有本地克隆帧）。
- **Feel check**: `pnpm dev`，然后：
  - 在文件树里右键一个文件：菜单应从光标位置的**左上角**长出，贴着光标的那个角基本不动，而不是整块淡入或从中心放大。
  - 在编辑器正文里右键：同上。
  - 点标题栏「导出 ▾」：下拉应与设置页里的 Select 下拉观感一致——这是本方案要消除的那处不一致，两者并排试一次。
  - 在**窗口最底部**右键（触发 `top` 钳制）：菜单整体上移，但仍应是向下展开的一块，不应出现「向上飘离光标」的感觉。
  - DevTools → Animations 面板，播放速度调到 10%，再右键一次：确认左上角是不动的原点，缩放只有 2%（`scale(0.98)` → `none`），位移只有 4px。
  - DevTools → Rendering → 勾选 `prefers-reduced-motion: reduce`，再右键：菜单应**瞬时**出现，无任何过渡（这是 `global.css:122` 全局兜底的预期行为，不是缺陷）。
- **Done when**: 右键菜单从光标锚点落下，与 `Select` / `ModelSelector` 的下拉观感一致；`ContextMenu.module.css` 无本地关键帧；八个调用点行为无回归。
