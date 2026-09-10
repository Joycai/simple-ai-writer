# 050 — 最后两处非合成层动效：分隔柄悬停线、对话图片占位扫光

- **Status**: DONE（2026-09-10，门禁已过；A 的「125%/150% 缩放下是否发虚」判据待作者目检，发虚则按第 3 步撤回；B 的 Paint flashing 需真 Tauri 窗口）
- **Commit**: 484fe4b
- **Severity**: LOW
- **Category**: 5 性能
- **Estimated scope**: 2 个文件，各一段 CSS（约 +15 / -8 行）；A 步是**条件性**的

> A 项来自第八批 README「本批未立案的 LOW 档」清单（`RecentProjects`/`ResizeHandle` 的 `width` 过渡）。
> 其中 `RecentProjects` 的那一条本轮**撤回**（理由见 README 第十批「撤回」一节），只剩 `ResizeHandle`。

## Problem

### A. 分隔柄悬停线过渡 `width`

```css
/* src/components/layout/ResizeHandle.module.css:12-28 — 当前 */
.handle::after {
  content: "";
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 1px;
  height: 100%;
  background: var(--color-border);
  transition: width var(--transition-fast), background var(--transition-fast);
}

.handle:hover::after,
.handle:active::after {
  width: 2px;
  background: var(--color-accent);
}
```

`width` 是布局属性（AUDIT §5）。代价很小（绝对定位的伪元素），但它是全库 transition 里最后一处 `width`（`plans/README.md` 第八批执行记录：「transition 里仍带 width 的规则：只剩 RecentProjects / ResizeHandle 两处 LOW 档」）。

### B. 对话图片占位的扫光逐帧重绘

```css
/* src/components/ai/AgentChat.module.css:865-883 — 当前 */
/* Holds the slot while the file is read, so the transcript doesn't jump. */
.turnImageLoading {
  display: block;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    100deg,
    var(--color-bg-surface) 30%,
    var(--color-bg-elevated) 50%,
    var(--color-bg-surface) 70%
  );
  background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite;
}

@keyframes shimmer {
  from { background-position: 200% 0; }
  to   { background-position: -200% 0; }
}
```

`background-position` 无限循环 = 每一帧重绘（paint），一轮对话里有几张图在读就有几个重绘循环。
元素是 `AgentChat.tsx:1137` 的 `<span className={styles.turnImageLoading} />`，父级 `.turnImage`（`:846-856`）148×148、`overflow: hidden`。

## Target

### A（条件性）

```css
/* target — src/components/layout/ResizeHandle.module.css:12-28 */
.handle::after {
  content: "";
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 1px;
  height: 100%;
  background: var(--color-border);
  transition: transform var(--transition-fast), background var(--transition-fast);
}

.handle:hover::after,
.handle:active::after {
  transform: translateX(-50%) scaleX(2);
  background: var(--color-accent);
}
```

**判据**（照方案 018 第 3 步 / 025 第 2 步的体例——不成立必须撤回）：Windows 显示缩放 100% / 125% / 150% 下，
悬停态的 2px 线用 DevTools 截图放大到 800% 对比改动前：若 `scaleX(2)` 的线**两侧出现半透明的发虚像素而改动前没有**，
撤回 A、保留原写法，并在本方案顶部 Status 行注明「A 按判据撤回」。

### B

```css
/* target — src/components/ai/AgentChat.module.css:865-883 */
/* Holds the slot while the file is read, so the transcript doesn't jump.
   The sweep is a translated pseudo-element — composited, not a per-frame
   background-position repaint (plan 050). */
.turnImageLoading {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--color-bg-surface);
}
.turnImageLoading::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    var(--color-bg-surface) 30%,
    var(--color-bg-elevated) 50%,
    var(--color-bg-surface) 70%
  );
  transform: translateX(-100%);
  animation: shimmer 1.2s linear infinite;
}

@keyframes shimmer {
  from { transform: translateX(-100%); }
  to   { transform: translateX(100%); }
}
```

- 关键帧**沿用 `shimmer` 这个名字**（方案 019/022 已把它列为合法的单点专用关键帧），只换关键帧体；不新增名字。
- 渐变两端用 `--color-bg-surface`（与宿主底色同色）而不是 `transparent`，所以伪元素不透明、移出去的部分被 `overflow: hidden` 裁掉，**不依赖**透明色插值。
- 方向不变（从左往右扫）。每轮只扫过一次，观感上可能比改动前略慢——**这是预期，不要调时长**。
- 伪元素基态停在 `translateX(-100%)`（完全在框外），所以动画被关掉时（reduced-motion）占位就是一块纯底色。

## Repo conventions to follow

- 「进度/扫光改走 transform」的范本：方案 010（仪表条 `width` → `scaleX`）、036（AgentLog 进度条）。
- 关键帧命名空间由 `src/lib/__tests__/cssKeyframeNames.test.ts`（方案 019）守着——本方案不改名，测试不受影响。
- 与方案 047 的关系：047 若已落地，它会在 `AgentChat.module.css` 的 reduced-motion 块里写 `.turnImageLoading, .turnImageLoading::after { animation: none; }`，
  并在上述测试里把 `shimmer` 列入 `SHIFT_EXEMPT`（不要求乘 `--motion-shift`）。两份谁先谁后都成立。

## Steps

1. **B**：`src/components/ai/AgentChat.module.css:865-883` 按 Target B 整段替换（注释、`.turnImageLoading`、新增的 `::after`、`@keyframes shimmer`）。同文件其他规则一个字不动。
2. **A**：`src/components/layout/ResizeHandle.module.css:12-28` 按 Target A 替换。
3. **A 的判据**：按 Target A 的判据实测；不成立则把第 2 步 `git checkout -- src/components/layout/ResizeHandle.module.css` 撤回，并在本文件 Status 行注明。

## Boundaries

- **不要**改 `ResizeHandle.tsx`（方案 021 加的 `onStart` 等逻辑）、`.handle` 本体的规则。
- **不要**改 `.turnImage` 及其 `:hover`、`AgentChat.tsx`。
- **不要**改 `shimmer` 的时长 `1.2s`，不要给它加 `ease`。
- **不要**碰 `RecentProjects.module.css` 的 `.pinBtn`（本轮已撤回，理由在 README）。
- 若摘录与代码对不上（自 484fe4b 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -rn "transition[^;]*\bwidth\b" src/components/layout/ResizeHandle.module.css` → 空（若 A 已按判据撤回则跳过此条）。
  - `grep -n "background-position" src/components/ai/AgentChat.module.css` → 空。
  - `pnpm exec tsc --noEmit`、`pnpm test`（含 `cssKeyframeNames.test.ts`；若 047 已落地，也含它新增的 `--motion-shift` 断言）、`pnpm build` 通过。
- **目检**：
  - **A**（`pnpm dev` 浏览器即可——`App.tsx:185-187` 只要是编辑器视图且侧栏未折叠就渲染分隔柄，不依赖项目）：鼠标悬停侧栏右边的分隔柄，线从 1px 变 2px 并变色，120ms，与改动前观感一致；拖拽时保持 2px。再按上面的判据查发虚。
  - **B**（需 `pnpm tauri dev`：让助手在对话里画一张图，或打开一个含图片回合的历史会话）：占位块上一道浅色光带从左往右扫过，循环流畅；图片到了之后占位消失。
  - **B 的性能判据**：DevTools → Rendering → 勾 **Paint flashing**，占位在扫光期间**不应**持续闪绿（改动前会每帧闪）。或 Performance 面板录 3 秒：扫光期间 Paint 事件应接近零。
  - Rendering → Emulate `prefers-reduced-motion: reduce`：占位是一块静止纯底色，没有停在半路的光带。
- **Done when**：B 的 Paint flashing 判据成立；A 要么落地且不发虚，要么按判据撤回并记录；门禁三项通过。
