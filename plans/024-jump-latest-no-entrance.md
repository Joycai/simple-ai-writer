# 024 — 「回到最新」气泡去掉入场动画

- **Status**: TODO
- **Commit**: 93eb7de
- **Severity**: LOW
- **Category**: 可中断性 / 用途与频次
- **Estimated scope**: 1 个 CSS 文件，删 1 行 + 删 1 个关键帧

## Problem

聊天记录里的「回到最新」气泡有入场动画、没有退场：

```css
/* src/components/ai/AgentChat.module.css:66 — 现状 */
  animation: jumpLatestIn 140ms var(--ease-out);
```
```css
/* src/components/ai/AgentChat.module.css:77-80 — 现状 */
@keyframes jumpLatestIn {
  from { opacity: 0; transform: translate(-50%, 6px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
```
```tsx
// src/components/ai/AgentChat.tsx:639-649 — 现状（条件渲染，无退场通道）
        {!stick.pinned && (
          <button type="button" className={styles.jumpLatest} onClick={stick.toBottom} …>
```

两个问题叠在一起，方向都指向「删掉它」而不是「补上退场」：

**一、它被一个没有滞回的阈值驱动。** `stick.pinned` 的判定是单阈值、无滞回：

```ts
// src/components/common/useStickToBottom.ts:9 与 :64 — 现状
const EDGE = 40;
const measure = () => arm(el.scrollHeight - el.clientHeight - el.scrollTop <= EDGE);
el.addEventListener("scroll", measure, { passive: true });
```

滚动位置停在 40px 边界附近时，触控板的惯性滚动会让 `pinned` 反复翻转；每翻转
一次按钮就重新挂载一次，而 **`@keyframes` 每次挂载都从零重放**（不像 transition
会从当前状态改瞄准）。同一个 `measure` 还挂在一个 `ResizeObserver` 上
（`useStickToBottom.ts:70-73`），所以拖窗口下边缘改变 `clientHeight` 时也会连续
翻转——那是一整段连续的 140ms 重放。AUDIT §4 说得直白：会被快速反复触发的界面
必须用 transition 或弹簧，不能用关键帧。

**二、补退场这条路被本仓库自己的规则挡住了。** design-system.md:251 明写：
「Do **not** spread Motion into buttons, hovers, list items, or other
element-level motion; those remain pure CSS keyframes.」`AnimatePresence` 是给
**表面**（视图切换、抽屉、模态）用的，不是给一个按钮用的。而 `.modal-closing`
那套 CSS 退场需要 JS 推迟卸载（`ModalShell` 的机制），为一个气泡拉这套过重。

于是剩下的就是 AUDIT §1 那条最有力的修法：**删掉这个动画**。这个按钮出现的位置
是固定的（transcript 底部居中），它不解释任何空间关系，也不是难以察觉的状态变化
——它自己就是一个显眼的提示条。方案 003（DONE）对 `InlineAiBubble` 做过完全同样
的判断，理由一字不差：由 `selectionchange` 驱动、反复重挂载，动画会在核心手势上
反复重放。

## Target

```css
/* src/components/ai/AgentChat.module.css:56-69 — 目标（只删 animation 那一行） */
.jumpLatest {
  …
  box-shadow: var(--shadow-md);
  cursor: pointer;
  /* 入场动画刻意没有：这个气泡由 useStickToBottom 的单阈值判定驱动（EDGE=40，
     无滞回，还挂着一个 ResizeObserver），边界附近的惯性滚动和拖窗口都会让它反复
     重挂载，而关键帧每次挂载都从零重放。同 InlineAiBubble（方案 003）。 */
  transition: color var(--transition-fast), border-color var(--transition-fast),
    background var(--transition-fast);
}
```

`@keyframes jumpLatestIn`（:77-80）整块删除——删完全库无人引用。

悬停与按压反馈（`:70-75` 的 `.jumpLatest:hover` 与 `.jumpLatest:active`）**保留
不动**：那是直接反馈，不是入场。

## Repo conventions to follow

- 先例就是方案 003（`plans/003-quiet-high-frequency-surfaces.md`，DONE）——它删掉
  `InlineAiBubble` 的 `scaleIn 160ms` 的理由与这里同构。`plans/README.md` 第四批
  那一节还专门写了「**不要重新加回去**」，本方案是同一条判断的延伸。
- design-system.md:247 记着 `CommandPalette` 的同类决策：键盘触发、高频的表面
  **刻意零动画**。
- 删掉动画时把「为什么没有动画」写成注释留在原地——本仓库的惯例是让下一个人
  看得见这是决定而不是遗漏（`TitleBar.module.css:179-180`、`AiPanel.tsx:1428` 都
  是这个体例）。

## Steps

1. `src/components/ai/AgentChat.module.css`
   - 删掉 `.jumpLatest` 块里的 `animation: jumpLatestIn 140ms var(--ease-out);`
     （:66），在原位换上 Target 里那段注释。
   - 删掉 `@keyframes jumpLatestIn { … }` 整块（:77-80）。
2. 确认 `grep -rn "jumpLatestIn" src` 零输出。

## Boundaries

- **不改 `src/components/ai/AgentChat.tsx`**——条件渲染保持原样。
- **不改 `src/components/common/useStickToBottom.ts`**。给 `EDGE` 加滞回是一个
  独立的、关于滚动手感的改动，可能是对的，但它不属于本方案，也不该由动画审计
  顺手决定。
- 不用 `AnimatePresence` 给它补退场（见 Problem 二）。
- 不动 `.jumpLatest:hover` / `.jumpLatest:active` / `.jumpLatest` 的任何视觉属性。
- 不动同文件里的 `shimmer`、`.thinkingSpinner` 及其 reduced-motion 块。

## Verification

- **机械**：
  - `grep -rn "jumpLatestIn" src` → 零输出。
  - `pnpm build` 通过。
  - 若方案 019 已落地：`pnpm test src/lib/__tests__/cssKeyframeNames.test.ts` 通过
    （删定义的同时删了唯一引用，两条断言都该继续过）。
- **感觉核验**（`pnpm dev` 或 `pnpm tauri dev`，需要一段够长的聊天记录）：
  - 往上滚动，气泡**立刻**出现，不再有 140ms 的浮起。
  - **重点回归**：把滚动位置停在距底部约 40px 处，用触控板做小幅惯性滚动来回蹭
    边界——气泡的出现/消失应当是干净的开关，**不许看到任何重复的浮起动画或闪烁**。
    这一条是本方案存在的理由，必须亲眼跑一次。
  - 再拖动窗口下边缘缩放（触发 `ResizeObserver` 那条路径），同样不许闪烁。
  - 悬停气泡：颜色/边框仍然有 120ms 过渡；按下：仍然下沉 1px。
- **Done when**：边界处来回蹭不再有任何重放；悬停与按压反馈原样保留。
