# 051 — 两处 JS 平滑滚动绕过了 reduced-motion

- **Status**: DONE（门禁已过；两处均为项目内/减动效交互，目检待作者）
- **Commit**: 485de63
- **Severity**: MEDIUM
- **Category**: 6 无障碍
- **Estimated scope**: 2 个 TSX 文件，各 1–2 行

## Problem

`global.css` 的减动效兜底里有这一条（方案 047 留下的）：

```css
/* src/styles/global.css:147-154 — 当前 */
@media (prefers-reduced-motion: reduce) {
  :root { --motion-shift: 0; }
  *, *::before, *::after {
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
  .cursor-blink { animation: none; }
}
```

`scroll-behavior: auto !important` 只管 **CSS 驱动的滚动**，以及 `scrollIntoView()` 不带参数（或 `behavior: "auto"`）的调用。
按 CSSOM View 规范，当调用方在 options 里**显式**写了 `behavior: "smooth"` 时，这个显式值优先于计算样式 `scroll-behavior`——
兜底对它无效。

全库有两处显式写了 `behavior: "smooth"`，因此在开启「减弱动态效果」时**仍然**会平滑滚动：

```tsx
// src/components/roleplay/RoleplayChat.tsx:625-627 — 当前
  const jumpToTurn = (turn: number) => {
    document.getElementById(`rp-turn-${turn}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
```

```tsx
// src/components/settings/panes/ContextMemoryPane.tsx:135-138 — 当前
  // The hard cap is now the first section of this very page, so the signpost
  // scrolls rather than navigates.
  const goToUtilization = () =>
    utilSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
```

两处都是**长距离跳转**（回卷到某一轮对话 / 从页面下方跳回第一节），正是大幅平滑滚动最容易引发前庭不适的场景——
减动效用户要的恰恰是这种跳转「一步到位」。

这不是取舍问题：仓库里**已经有**正确写法，这两处只是没跟上（见下节）。

## Target

```tsx
// target — src/components/roleplay/RoleplayChat.tsx:625-627
  const jumpToTurn = (turn: number) => {
    // 显式 behavior 会压过 global.css 的 `scroll-behavior: auto !important`（方案 051），
    // 所以减动效要在这里自己判一次。体例同 LoreReadView.tsx:205。
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(`rp-turn-${turn}`)
      ?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  };
```

```tsx
// target — src/components/settings/panes/ContextMemoryPane.tsx:135-140
  // The hard cap is now the first section of this very page, so the signpost
  // scrolls rather than navigates.
  const goToUtilization = () => {
    // 显式 behavior 会压过 global.css 的 `scroll-behavior: auto !important`（方案 051）。
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    utilSectionRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  };
```

注意两处的 options 键序**保持各自原样**（一处 `block` 在前，一处 `behavior` 在前）——不要顺手统一，diff 越小越好。

## Repo conventions to follow

- **范本（照抄这一行的形状）** —— `src/components/lore/LoreReadView.tsx:205-206`，仓库里已经正确处理的那一处：

  ```tsx
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  wall.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
  ```

- 另一处同款读取在 `src/stores/appStore.ts:529`（`applyThemeAnimated` 里决定要不要走 View Transition）。
- **可选链 `matchMedia?.`** 是有意的：非浏览器宿主（测试环境）下 `window.matchMedia` 可能不存在，`?.` 让结果为 `undefined` → 走 `"smooth"` 分支，与今天的行为一致。照抄，不要改成 `window.matchMedia(...)`。
- 每次调用现读、不缓存、不加监听器：这是本仓已确立的做法（上面两处都如此），跳转是低频动作，读 `matchMedia` 的成本可以忽略。

## Steps

1. `src/components/roleplay/RoleplayChat.tsx` —— 把 `:625-627` 的 `jumpToTurn` 整个函数体替换为 Target 第一段。
2. `src/components/settings/panes/ContextMemoryPane.tsx` —— 把 `:137-138` 的 `goToUtilization` 替换为 Target 第二段（箭头函数从表达式体改成块体，注意补 `{}` 和分号）。
3. 不要新增共享 helper 文件。本仓的既定做法就是在调用点内联（已有两处先例），第三、四处继续内联；抽成 `lib/` 工具是另一个决定，不在本方案范围。

## Boundaries

- **不要**改 `src/styles/global.css`。兜底本身没有错，它只是管不到显式 options。
- **不要**改 `src/components/lore/LoreReadView.tsx`（它已经是对的，是本方案的范本）。
- **不要**动 CodeMirror 的滚动路径：`EditorScrollNav.tsx:61-72`、`lib/editor/format.ts` 里的 `EditorView.scrollIntoView(...)` 走的是编辑器自己的滚动实现，**不是** DOM 的 `scrollIntoView`，与本方案无关（方案 030 的注释解释了为什么那里刻意不用原生平滑滚动）。
- **不要**改这两个函数的调用方、按钮或任何样式。
- **不要**改 options 里 `block` 的值（两处都是 `"center"`，保持）。
- 若摘录与代码对不上（自 `485de63` 起漂移），**停下并报告**，不要即兴发挥。

## Verification

- **机械**：
  - `grep -rn 'behavior: *"smooth"' src --include=*.tsx --include=*.ts` —— 命中的每一行都必须在同一条语句里带 `reduced ?`。预期命中 3 处（LoreReadView 那处是 `scrollTo` 不是 `scrollIntoView`，同样应带 `reduced ?`）。
  - `grep -rn 'scrollIntoView({[^}]*"smooth"' src` 的每一处上方 1–3 行内应能看到 `matchMedia`。
  - `node_modules/.bin/tsc --noEmit` —— 无诊断（**直跑二进制**，绕开 pnpm 的安装摘要；`pnpm tsc` 在锁文件陈旧时会打印安装摘要并以 0 退出而不做检查）。
  - `pnpm test` —— 全绿。
  - `pnpm build` —— 成功。
- **Feel check**：
  - **减动效开启**（DevTools → Rendering → Emulate CSS media feature `prefers-reduced-motion: reduce`）：
    - 设置 → 上下文与记忆：点「硬上限」那条指路（`goToUtilization` 的触发点），页面应**一帧到位**跳到第一节，没有任何滚动补间。
    - 扮演对话（需项目，`pnpm tauri dev`）：用回退条跳到某一轮，转录应**一帧到位**，不滚动。
  - **减动效关闭**（默认）：同样两个操作应与改动前**完全一致**——仍然平滑滚动。本方案在普通模式下必须零变化。
  - 用 DevTools Performance 录一次减动效下的跳转：滚动区间内不应出现连续多帧的 `scrollTop` 变化，只有一次跳变。
- **Done when**：上述两个交互在减动效下瞬时到位、在普通模式下与改动前无差别；三项门禁通过。
