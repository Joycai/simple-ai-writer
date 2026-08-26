# 021 — 侧栏拖拽按帧合并写入

- **Status**: TODO
- **Commit**: 93eb7de
- **Severity**: MEDIUM
- **Category**: 性能
- **Estimated scope**: 1 个文件（`src/App.tsx`），~12 行

## Problem

方案 001（DONE）解决了拖拽时的**过渡**问题——`data-resizing` 期间豁免
`.sidebar` 的 320ms width 过渡。它没有碰的是**写入频率**：

```tsx
// src/App.tsx:44-49 — 现状（拖拽每次 mousemove 都完整走一遍）
const onResizeDelta = (d: number) => {
  const cur = dragWidth.current ?? useAppStore.getState().sidebarWidth;
  dragWidth.current = clampSidebarWidth(cur + d);
  layoutRef.current?.setAttribute("data-resizing", "");
  layoutRef.current?.style.setProperty("--sidebar-width", `${dragWidth.current}px`);
};
```

```tsx
// src/components/layout/ResizeHandle.tsx:18-22 — 现状（无节流，原始事件直通）
const onMove = (ev: MouseEvent) => {
  if (!dragging.current) return;
  onDelta(ev.clientX - prevX);
  prevX = ev.clientX;
};
```

两件事叠在一起：

1. `mousemove` 的派发频率跟随**鼠标采样率**而非刷新率。120Hz / 1000Hz 的鼠标在
   一次拖拽里能打出远超每帧一次的事件，macOS 上 WKWebView 也不会替你合并。
2. `--sidebar-width` 写在**布局根节点**上。自定义属性的写入会让整棵子树的样式
   失效重算，而 `.sidebar { width: var(--sidebar-width) }` 又让每次写入强制回流
   ——这条回流路径上挂着 `EditorArea` 和 CodeMirror 的整列文本（会重新折行）。

于是一帧之内可能重复做好几次「样式重算 + 整个编辑器回流」，而屏幕只画得出一次。
多余的那几次是纯浪费，且正好落在**拖拽**这个对流畅度要求最高的手势上。

方案 001 的注释已经点明写入路径「每帧 width 变化都触发编辑器整列的 relayout」，
但当时的修法只针对过渡，频率这一半留了下来。

## Target

把写入合并到 rAF：`mousemove` 只更新一个 ref，真正的 DOM 写入一帧最多一次。
`data-resizing` 从「每次移动都设」改成「拖拽开始设一次」。

```tsx
// src/App.tsx — 目标
const layoutRef = useRef<HTMLDivElement>(null);
const dragWidth = useRef<number | null>(null);
const rafId = useRef<number | null>(null);

// 一次拖拽里 mousemove 的派发频率跟随鼠标采样率，不是刷新率；而每次写
// `--sidebar-width` 都要让整棵布局子树重算样式并强制编辑器整列回流。一帧只画得
// 出一次，所以一帧只写一次——多出来的那几次是纯浪费。
const flushWidth = () => {
  rafId.current = null;
  if (dragWidth.current === null) return;
  layoutRef.current?.style.setProperty("--sidebar-width", `${dragWidth.current}px`);
};

const onResizeStart = () => {
  layoutRef.current?.setAttribute("data-resizing", "");
};

const onResizeDelta = (d: number) => {
  const cur = dragWidth.current ?? useAppStore.getState().sidebarWidth;
  dragWidth.current = clampSidebarWidth(cur + d);
  if (rafId.current === null) rafId.current = requestAnimationFrame(flushWidth);
};

const onResizeEnd = () => {
  // 松手时必须同步补写最后一次：最后一个 mousemove 排的那帧可能还没跑，
  // 而下一行就要移除 data-resizing 把 320ms 过渡放回来——留着差值就会看到
  // 侧栏在松手后自己飘一小段。
  if (rafId.current !== null) {
    cancelAnimationFrame(rafId.current);
    rafId.current = null;
  }
  flushWidth();
  layoutRef.current?.removeAttribute("data-resizing");
  if (dragWidth.current !== null) setSidebarWidth(dragWidth.current);
  dragWidth.current = null;
};
```

`ResizeHandle` 增加一个 `onStart` 回调（`onEnd` 已有先例，形状照抄）：

```tsx
// src/components/layout/ResizeHandle.tsx — 目标（接口部分）
interface Props {
  onDelta: (delta: number) => void;
  /** Called once when a drag gesture starts — the place to flag the drag. */
  onStart?: () => void;
  /** Called once when a drag gesture ends — the place to commit/persist. */
  onEnd?: () => void;
}
```

`handleMouseDown` 里在 `dragging.current = true;` 之后调 `onStart?.()`。

## Repo conventions to follow

- `ResizeHandle` 已有的 `onEnd?: () => void` 就是「一次手势一次回调」的先例
  （`src/components/layout/ResizeHandle.tsx:5-7`）；`onStart` 照同一形状写，
  注释也照同一体例。
- `src/App.tsx:41-43` 已有的注释解释了「为什么拖拽不走 store」——本次改动是同一
  条推理的延伸，把新注释接在它下面，不要另起一段重复它。
- 本仓库的 rAF 都是**一次性**的（`AgentChat.tsx:178`、`AiPanel.tsx:1102`），
  没有常驻动画循环；这里也一样，是「合并到下一帧」而不是开一个循环。

## Steps

1. `src/components/layout/ResizeHandle.tsx`：
   - `Props` 加 `onStart?: () => void`（带上 Target 里那行文档注释）。
   - 函数签名解构改成 `({ onDelta, onStart, onEnd })`。
   - `handleMouseDown` 里 `dragging.current = true;` 的**下一行**加 `onStart?.();`。
2. `src/App.tsx`：
   - 在 `dragWidth` 那行下面加 `const rafId = useRef<number | null>(null);`。
   - 按 Target 替换 `onResizeDelta` / `onResizeEnd`，并新增 `flushWidth` 与
     `onResizeStart`。
   - 找到 `<ResizeHandle onDelta={onResizeDelta} onEnd={onResizeEnd} />`
     （约 `src/App.tsx:133`），加上 `onStart={onResizeStart}`。
3. 确认 `onResizeDelta` 里**已经没有** `setAttribute` 调用（它搬到 `onResizeStart`
   去了），也没有 `setProperty` 调用（它搬到 `flushWidth` 去了）。

## Boundaries

- **不改 `Sidebar.module.css`。** 折叠/展开的 320ms width 过渡和
  `:global([data-resizing]) .sidebar { transition: none; }` 都是方案 001 定下的，
  必须原样保留。
- 不把宽度改成走 store —— `src/App.tsx:41-43` 的注释解释了为什么不能（每次
  mousemove 一次全树重渲染 + 一次 SQLite 写）。
- 不改 `clampSidebarWidth`，不改 `setSidebarWidth` 的调用时机（仍然只在松手时一次）。
- 不给 `ResizeHandle` 加 pointer events / setPointerCapture 改造——那是另一件事，
  本方案只合并写入频率。
- 不要用 `setTimeout` 或 `throttle` 替代 `requestAnimationFrame`：需要的是
  「对齐到帧」，不是「限速到某个毫秒数」。

## Verification

- **机械**：
  - `pnpm tsc --noEmit` 通过（`onStart` 是可选属性，旧调用点若有遗漏不会报错——
    所以第 2 步第三小点要手工确认已传上）。
  - `pnpm build` 通过。
- **感觉核验**：`pnpm tauri dev`（这一项**必须在真窗口里量**，不要用浏览器预览
  面板——见方案 023 记录的 `visibilityState` 陷阱）：
  - 抓住侧栏分隔条快速左右拖拽：侧栏边缘应当**紧贴**光标，不落后、不过冲；
    松手瞬间不许有任何回弹或继续飘动（这一条专门测 `onResizeEnd` 里的同步补写）。
  - 打开 DevTools → Performance，录一次 3 秒的来回拖拽：
    - 改动前后各录一次对比。**Recalculate Style / Layout 的次数应显著下降**，
      且每帧不超过一次；改动后 `Layout` 事件数应当约等于帧数。
    - 帧率不掉到 60fps 以下（编辑器里先打开一个上千行的长文档再录，短文档
      测不出这条路径的成本）。
  - 拖到最左/最右撞上 `clampSidebarWidth` 的边界，来回蹭：宽度不许抖动或跳变。
  - 折叠再展开侧栏（不拖拽）：320ms 的过渡**必须还在**，观感与改动前一致。
- **Done when**：Performance 面板里一帧一次 Layout；松手无飘动；折叠过渡未受影响。
