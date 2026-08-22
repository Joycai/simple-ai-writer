# 001 — 拖拽侧栏宽度时禁用 width 过渡

- **Status**: DONE (2026-08-22)
- **Commit**: 0f49132
- **Severity**: HIGH
- **Category**: 可中断性 / 性能
- **Estimated scope**: 2 个文件，各 ~3 行

## Problem

侧栏的宽度过渡是为「折叠/展开」写的，但它同样套在了拖拽调宽上。`ResizeHandle` 每次 `mousemove` 都往布局根节点写一次 `--sidebar-width`，而 `.sidebar` 对 `width` 挂着 **320ms** 的过渡——每一次写入都重新瞄准一段 320ms 的插值，于是整个拖拽过程中侧栏边缘落后光标约三分之一秒，松手后还要继续飘一段。同时每帧 width 变化都触发编辑器整列的 relayout。

```css
/* src/components/layout/Sidebar.module.css:10 — 现状 */
.sidebar {
  width: var(--sidebar-width);
  ...
  transition: width var(--transition-slow), border-right-width var(--transition-slow);
}
```

```tsx
// src/App.tsx:41-49 — 现状（拖拽每次 mousemove 都走这里）
const onResizeDelta = (d: number) => {
  const cur = dragWidth.current ?? useAppStore.getState().sidebarWidth;
  dragWidth.current = clampSidebarWidth(cur + d);
  layoutRef.current?.style.setProperty("--sidebar-width", `${dragWidth.current}px`);
};
const onResizeEnd = () => {
  if (dragWidth.current !== null) setSidebarWidth(dragWidth.current);
  dragWidth.current = null;
};
```

折叠/展开的过渡本身是对的，**必须保留**；要做的只是拖拽期间把它关掉。

## Target

拖拽进行时布局根节点带上 `data-resizing` 属性，CSS 用它豁免过渡；拖拽结束移除属性，折叠/展开的 320ms 过渡照旧。

```tsx
// src/App.tsx — 目标
const onResizeDelta = (d: number) => {
  const cur = dragWidth.current ?? useAppStore.getState().sidebarWidth;
  dragWidth.current = clampSidebarWidth(cur + d);
  layoutRef.current?.setAttribute("data-resizing", "");
  layoutRef.current?.style.setProperty("--sidebar-width", `${dragWidth.current}px`);
};
const onResizeEnd = () => {
  layoutRef.current?.removeAttribute("data-resizing");
  if (dragWidth.current !== null) setSidebarWidth(dragWidth.current);
  dragWidth.current = null;
};
```

```css
/* src/components/layout/Sidebar.module.css — 目标：在 .sidebar 规则后追加 */
:global([data-resizing]) .sidebar {
  transition: none;
}
```

## Repo conventions to follow

- 过渡令牌在 `src/styles/tokens.css:52-54`（`--transition-slow: 320ms var(--ease-out)`）——不要改令牌，本方案只做作用域控制。
- CSS Modules 里引用全局属性选择器用 `:global(...)`，仓库内先例：`src/components/roleplay/ScriptText.module.css` 等文件的 `:global` 用法。
- 拖拽已经刻意绕开 React 状态走 ref + CSS 变量（见 `src/App.tsx:35-38` 的注释），保持这个模式，不要引入 state。

## Steps

1. `src/App.tsx`：在 `onResizeDelta` 里 `setProperty` 之前加 `layoutRef.current?.setAttribute("data-resizing", "");`；在 `onResizeEnd` 开头加 `layoutRef.current?.removeAttribute("data-resizing");`（按上文目标代码逐行对照）。
2. `src/components/layout/Sidebar.module.css`：在 `.sidebar.collapsed` 规则（第 13-16 行）之后新增 `:global([data-resizing]) .sidebar { transition: none; }`。

## Boundaries

- 不改 `ResizeHandle.tsx`（它本身没问题）。
- 不改 `--transition-slow` 令牌、不改折叠/展开行为。
- 不动 `.sidebar` 现有的 `transition` 声明本身。
- 如果发现代码与上面摘录不一致（相对 0f49132 有漂移），停下来报告，不要即兴发挥。

## Verification

- **Mechanical**: `pnpm tsc --noEmit` 通过；`pnpm build` 通过。
- **Feel check**: `pnpm dev` 打开应用：
  - 拖动侧栏与编辑器之间的把手：侧栏边缘应贴住光标，零滞后；松手瞬间停住，不再飘移。
  - 点击图标栏的折叠按钮：侧栏仍以 320ms 平滑收起/展开（过渡未被误伤）。
  - 快速交替「拖拽 → 折叠 → 展开 → 再拖拽」：无一次硬跳。
- **Done when**: 拖拽零滞后且折叠动画保持不变。
