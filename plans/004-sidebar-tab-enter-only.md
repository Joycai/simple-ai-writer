# 004 — 侧栏标签切换去掉 mode="wait" 串行动画

- **Status**: DONE (2026-08-22)
- **Commit**: 0f49132
- **Severity**: MEDIUM
- **Category**: 目的与频率 / 一致性
- **Estimated scope**: 1 个文件（Sidebar.tsx），~6 行

## Problem

侧栏在文件/大纲/知识库标签间切换是全应用最高频的导航之一，但它用了 `AnimatePresence mode="wait"`：旧面板要**完整播完退出动画**，新面板才开始进场——每次切换用户白等两段弹簧时长。

```tsx
// src/components/layout/Sidebar.tsx:121-130 — 现状
<AnimatePresence mode="wait" initial={false}>
<motion.div
  key={projectPath ? activeSideTab : "empty"}
  className={isTree ? styles.contentFlush : styles.content}
  variants={panelFade}
  initial="initial"
  animate="animate"
  exit="exit"
  transition={springPanel}
>
```

仓库自己已经否决过这个模式：`src/components/ai/AiPanel.tsx:1384-1392` 的注释明确写着 *"an AnimatePresence `mode="wait"` crossfade would hold the outgoing branch on screen for the length of its exit before the new one appears, and a task switch is a direct manipulation that should land under the cursor immediately"*，并采用了 **enter-only**（keyed `motion.div`，只有 initial/animate，无 AnimatePresence、无 exit）。两个切换器行为不一致，慢的那个恰恰是更高频的。

## Target

照搬 AiPanel 的 enter-only 模式：去掉 `AnimatePresence` 包裹和 `exit` 属性，保留 keyed `motion.div` + `panelFade` 的 initial/animate。新内容立即接管并做 6px 轻微上浮淡入，无串行等待。

```tsx
// src/components/layout/Sidebar.tsx — 目标
{/* Enter-only（照 AiPanel.tsx:1384 的注释与先例）：标签切换是直接操纵，
    新面板应立即落位；keyed motion.div 仍会重置子树。 */}
<motion.div
  key={projectPath ? activeSideTab : "empty"}
  className={isTree ? styles.contentFlush : styles.content}
  variants={panelFade}
  initial="initial"
  animate="animate"
  transition={springPanel}
>
  ...children 不变...
</motion.div>
```

## Repo conventions to follow

- 模式先例与理由注释：`src/components/ai/AiPanel.tsx:1384-1395`。
- `panelFade` / `springPanel` 定义在 `src/lib/motion.ts:57-61` / `:25-30`——不要改动它们。

## Steps

1. `src/components/layout/Sidebar.tsx`：删除第 121 行 `<AnimatePresence mode="wait" initial={false}>` 与对应的 `</AnimatePresence>` 闭合标签；从 `motion.div` 上删除 `exit="exit"` 属性。
2. 检查文件顶部 import：若 `AnimatePresence` 不再被本文件使用，从 `motion/react` 的 import 中移除，避免 `noUnusedLocals` 报错。

## Boundaries

- 不动 `src/lib/motion.ts` 的任何 preset。
- 不动侧栏内容组件（FileTree、大纲、知识库面板）。
- 不动 App.tsx 顶层视图切换的 AnimatePresence（那是全屏视图转场，不同场景）。
- 若代码与摘录不符（相对 0f49132 有漂移），停下报告。

## Verification

- **Mechanical**: `pnpm tsc --noEmit` 通过（尤其确认无 unused import）；`pnpm build` 通过。
- **Feel check**: `pnpm dev`，打开一个项目：
  - 快速点击侧栏各标签来回切换：新面板**立即**出现（带轻微上浮淡入），不再有「旧的先淡出、空一拍、新的才进来」的节奏。
  - 连续快速切换不产生闪烁或残影。
  - 首次打开项目时侧栏首个面板出现无异常（enter 动画播一次是可接受的）。
- **Done when**: 标签切换即点即达，与 AiPanel 任务切换的手感一致。
