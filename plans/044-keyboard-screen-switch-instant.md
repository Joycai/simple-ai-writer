# 044 — ⌘1‥⌘5 触发的主视图与侧栏标签切换去动画（决策变更）

- **Status**: DONE（2026-09-10，PR #575；作者真窗口目检通过）
- **Commit**: 484fe4b
- **Severity**: HIGH
- **Category**: 1 目的与频率
- **Estimated scope**: 4 个文件——`src/App.tsx`、`src/components/layout/Sidebar.tsx`、`src/lib/motion.ts`、`docs/reference/design-system.md`；净删约 25 行

> **这是对既有决策的显式变更**，体例同方案 014（⌘K 面板）与 031（侧栏折叠）。建议单独审阅。
>
> 被推翻的两条：
> 1. 方案 004 的 Boundaries「不动 App.tsx 顶层视图切换的 AnimatePresence（那是全屏视图转场，不同场景）」；
> 2. 方案 004 为侧栏标签切换保留的 enter-only 上浮淡入。
>
> 推翻的依据是**事实变了**，不是品味变了：004 定于 2026-08-22，那时这两个切换只有鼠标入口。
> 两天后 `677db8d`（2026-08-24「feat(shortcuts): ⌘1‥⌘5 在五个界面之间切换」）把它们都接上了键盘。

## Problem

`src/lib/shortcuts.ts:132-138` —— 当前：

```ts
export const SCREEN_COMBOS: { screen: AppScreen; combo: Combo }[] = [
  { screen: "files", combo: { mod: true, key: "1" } },
  { screen: "outline", combo: { mod: true, key: "2" } },
  { screen: "knowledge", combo: { mod: true, key: "3" } },
  { screen: "library", combo: { mod: true, key: "4" } },
  { screen: "settings", combo: { mod: true, key: "5" } },
];
```

`src/stores/appStore.ts:852-868` 把它们分成两类：⌘3/⌘4 → `setMainView(...)`（主视图），
⌘1/⌘2 → `setMainView("editor")` + `setActiveSideTab(screen)`（侧栏标签）。两类都各带一段 Motion 转场：

**一、主视图切换**（⌘3 / ⌘4，以及回到编辑器的 ⌘1 / ⌘2）

```tsx
/* src/App.tsx:189-205 — 当前 */
        <div style={{ flex: 1, position: "relative", minWidth: 0, overflow: "hidden" }}>
          <AnimatePresence initial={false}>
            <motion.div
              key={view}
              variants={viewVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={springScreen}
              style={fillLayer}
            >
              {view === "editor" && <EditorArea />}
              {view === "lore-wall" && <LoreWall />}
              {view === "library" && <LibraryView />}
            </motion.div>
          </AnimatePresence>
        </div>
```

`viewSlide`（`src/lib/motion.ts:72-77`）是横向 26px / -22px 滑动 + 淡入淡出；`springScreen`
（`:57-62`，stiffness 320 / damping 34 / mass 0.9）阻尼比 ≈ 1.00，按参数估算约 0.3–0.35s 才落定。
没有 `mode`，所以退场层在弹簧落定前**一直挂着**——编辑器（整棵 CodeMirror）与知识库墙
两棵重树在同一段时间里同时渲染，恰好是主线程最忙的时候。

**二、侧栏标签切换**（⌘1 / ⌘2，以及 IconRail 点击）

```tsx
/* src/components/layout/Sidebar.tsx:56-65 — 当前 */
      {/* Enter-only（照 AiPanel.tsx:1384 的注释与先例）：标签切换是直接操纵，
          新面板应立即落位；keyed motion.div 仍会重置子树。 */}
      <motion.div
        key={projectPath ? activeSideTab : "empty"}
        className={projectPath && isTree ? styles.contentFlush : styles.content}
        variants={contentVariants}
        initial="initial"
        animate="animate"
        transition={springPanel}
      >
```

`contentVariants` = `useMotionPreset(panelFade)`（`Sidebar.tsx:38`），上浮 6px + 淡入，
`springPanel` 约 0.25s 落定。**方案 031 自己写下的注释**（`src/components/layout/Sidebar.module.css:12-17`）
已经把同一颗按钮定为「与 100+/天的切标签同一颗按钮，属 AUDIT §1『永不动画』那一档」——
折叠照这个判断删了过渡，内容区却还在动。

按 AUDIT §1 频次表：「100+ times/day (keyboard shortcuts, command palette toggle) → No animation. Ever.」

## Target

两处都换成普通 `div`，**保留 `key`**（保持「换视图 / 换标签 = 整棵子树重挂」的既有语义，只去掉动效）。

```tsx
/* target — src/App.tsx:189-205 */
        <div style={{ flex: 1, position: "relative", minWidth: 0, overflow: "hidden" }}>
          {/* 主视图切换不做转场（方案 044）：⌘1‥⌘5（lib/shortcuts.ts SCREEN_COMBOS）
              直达，属键盘高频动作，AUDIT §1「永不动画」。原先的 AnimatePresence +
              viewSlide 让退场层在弹簧落定（约 0.3s）前与新视图同时挂载——编辑器与
              知识库两棵重树叠在一起。key 保留：换视图仍是整棵重挂。 */}
          <div key={view} style={fillLayer}>
            {view === "editor" && <EditorArea />}
            {view === "lore-wall" && <LoreWall />}
            {view === "library" && <LibraryView />}
          </div>
        </div>
```

```tsx
/* target — src/components/layout/Sidebar.tsx:56-65（以及对应的闭合标签 :79） */
      {/* 标签切换不做入场（方案 044）：⌘1/⌘2（lib/shortcuts.ts SCREEN_COMBOS）与
          IconRail 是同一个动作，100+/天，AUDIT §1「永不动画」——与 Sidebar.module.css
          顶部注释给折叠定的是同一档。方案 004 的 enter-only 入场定于 ⌘1‥⌘5 出现之前。
          key 保留：换标签仍重置子树。 */}
      <div
        key={projectPath ? activeSideTab : "empty"}
        className={projectPath && isTree ? styles.contentFlush : styles.content}
      >
```

`src/lib/motion.ts`：删除 `viewSlide`（再无消费者）；`panelFade` 的注释去掉「sidebar tabs」。

`docs/reference/design-system.md`：Motion 例外清单里移除这两个用例，写明决策变更。

## Repo conventions to follow

- 删除高频/键盘表面动效的既有处方：方案 003、014、024、031。**同为决策变更**的体例：014、031（都带文档同步步骤）。
- `fillLayer`（`src/lib/motion.ts:104-110`）继续用作包裹层的样式——它给出 `position:absolute; inset:0; flex column`，子视图依赖这个布局，不要换成别的样式。
- `panelFade` / `springPanel` / `springScreen` / `fillLayer` **仍有其他消费者**（AiPanel、SettingsPage、LoreWall），**不要删**。只有 `viewSlide` 变成零消费者。
- TypeScript 开着 `noUnusedLocals`：删掉用法后必须同步删 import，否则 `tsc` 报错。

## Steps

1. **`src/App.tsx:2`** —— `import { AnimatePresence, motion, MotionConfig } from "motion/react";`
   改为 `import { AnimatePresence, MotionConfig } from "motion/react";`
   （`AnimatePresence` 仍被 `:209` 的设置页使用，`MotionConfig` 仍在 `:156`，都要保留。）
2. **`src/App.tsx:39`** —— `import { fillLayer, springScreen, useMotionPreset, viewSlide } from "./lib/motion";`
   改为 `import { fillLayer } from "./lib/motion";`
3. **`src/App.tsx:153`** —— 删除整行 `const viewVariants = useMotionPreset(viewSlide);`（连同其后的空行只留一个）。
4. **`src/App.tsx:189-205`** —— 按 Target 替换（含注释）。
5. **`src/components/layout/Sidebar.tsx:2`** —— 删除整行 `import { motion } from "motion/react";`
6. **`src/components/layout/Sidebar.tsx:10`** —— 删除整行 `import { panelFade, springPanel, useMotionPreset } from "../../lib/motion";`
7. **`src/components/layout/Sidebar.tsx:38`** —— 删除整行 `const contentVariants = useMotionPreset(panelFade);`（连同其后多余空行）。
8. **`src/components/layout/Sidebar.tsx:56-65`** —— 按 Target 替换开标签与注释；**`:79`** 的 `</motion.div>` 改为 `</div>`。子元素（`RecentProjects` / `FileTree` / `OutlineTab` / 搜索占位）一个字不动。
9. **`src/lib/motion.ts:72-77`** —— 删除整个 `viewSlide` 导出（含 `:72` 的注释行 `/** Horizontal slide + fade — top-level view switches (crossfade over each other). */`）。
10. **`src/lib/motion.ts:96`** —— `/** Light vertical fade for in-flow panel content (sidebar tabs). */`
    改为 `/** Light vertical fade for in-flow panel content (the AI panel's task switch) and the settings page. */`
11. **`docs/reference/design-system.md:395`** —— 整行替换为：
    ```
    - **Screen / content switches** — `LoreWall.tsx` (grid↔detail push), `AiPanel.tsx` (task/instruction config, enter-only keyed by selected task). `App.tsx`'s main view switch and `Sidebar.tsx`'s tab switch are a decision change from this (plan 044): both are reachable from ⌘1‥⌘5, a keyboard-triggered, high-frequency action, so they switch with no animation.
    ```
    （顺带把 AiPanel 那条过期的 `mode="wait"` 描述改成 enter-only——方案 004 之后它就不是 `mode="wait"` 了。）
12. **`docs/reference/design-system.md:400`** —— 预设清单 `` (`springScreen`/`springPanel`/`springDrawer`, `viewSlide`, `pushForward`/`pushBackdrop`, `panelFade`, `overlayFade`, `drawerSlide`, `modalPop`, `fillLayer`) ``
    改为 `` (`springScreen`/`springPanel`/`springDrawer`, `pushForward`/`pushBackdrop`, `panelFade`, `overlayFade`, `drawerSlide`, `fillLayer`) ``
    （`viewSlide` 本方案删除；`modalPop` 早已被方案 041 删除，文档一直没跟上。）

## Boundaries

- **不要**动 `src/App.tsx:209-213` 设置页外面的 `<AnimatePresence>`，也不要动 `:156` 的 `<MotionConfig reducedMotion="user">`。
- **不要**删 `panelFade` / `springPanel` / `springScreen` / `fillLayer`。
- **不要**动 `EditorArea.module.css` 里 `.editorPane` / `.previewPane` 的 `fadeIn 160ms`（方案 011 的既定决策）。本方案落地后，回到编辑器时唯一剩下的动效就是它——160ms 纯 opacity，**这是预期，不是遗漏**。
- **不要**动 `LoreWall.module.css` 里整墙的 `fadeIn`（方案 025 的既定决策）；⌘3 进知识库时看到的 200ms 淡入来自它。
- **不要**动 `LoreWall.tsx` / `AiPanel.tsx` 的 Motion（网格↔详情推进见方案 045；AiPanel 的 enter-only 是既定决策）。
- **不要**改快捷键、`showScreen`、IconRail 的任何逻辑。
- **不要**删 `key`——它决定子树何时重挂，删掉会改变组件生命周期。
- 若任何一段摘录与代码对不上（自 484fe4b 起漂移），**停下并报告**，不要即兴发挥。

## Verification

- **机械**：
  - `grep -rn "viewSlide" src docs/reference` → **必须为空**。
  - `grep -n "motion/react\|useMotionPreset\|panelFade" src/components/layout/Sidebar.tsx` → **必须为空**（注释里提到的「方案 004」不含这些词）。
  - `pnpm exec tsc --noEmit` 无诊断（重点：无 unused import）。
  - `pnpm test` 全绿。
  - `pnpm build` 成功。
- **目检**（需 `pnpm tauri dev` + 一个真实项目——知识库/文库/侧栏标签在浏览器 dev server 里打不开项目，看不到）：
  - 连按 ⌘1 / ⌘2 十次：侧栏面板**一帧到位**，没有上浮、没有淡入。
  - ⌘1 → ⌘3 → ⌘4 → ⌘1：视图直接换，**没有横向滑动、没有两层叠影**。
    进知识库时有 200ms 整墙淡入（方案 025）、回编辑器时窗格 160ms 淡入（方案 011）——都是纯 opacity，属预期。
  - 用鼠标点 IconRail 做同样的切换：行为与键盘一致。
  - DevTools → Animations 面板打开录制，切一次视图：**不应出现任何 transform 动画**，只允许上面两条 CSS `fadeIn`。
  - 快速 ⌘3/⌘1 交替：不再出现「编辑器还没退完、知识库已经进来」的叠影或掉帧。
- **Done when**：两条 grep 为空、门禁三项通过，且 ⌘1‥⌘4 的任何切换都没有位移动画。
