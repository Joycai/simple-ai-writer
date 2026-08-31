# 040 — 两处一次性闪烁在重复触发时静默失效

- **Status**: DONE（门禁已过，目检待作者）
- **Commit**: 43b52e9
- **Severity**: LOW-MEDIUM
- **Category**: 4 可中断性
- **Estimated scope**: 2 个 TS/TSX 文件，各约 4 行

> 两处是**同一个失效模式、同一个处方**，且仓库里已经有一份写对了的范本。
> 合成一份方案。

## Problem

CSS 动画**在类名已经存在于元素上时不会重启**。仓库里有两处一次性闪烁踩了这一条，
且两处的共同点是：**闪烁本身就是那次操作的唯一告知**，所以静默失效等于回到缺陷状态。

### 一、光标落点闪烁（跳到结尾）

```ts
/* src/lib/editor/caretFlash.ts:63-73 — 当前 */
export function flashCaretLanding(view: EditorView, pos: number): void {
  const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
  if (pending !== null) window.clearTimeout(pending);
  view.dispatch({ effects: setCaretFlash.of(clamped) });
  pending = window.setTimeout(() => {
    pending = null;
    // The view may already be gone (file switch, project close) — check
    // before dispatching into a destroyed editor.
    if (view.dom.isConnected) view.dispatch({ effects: setCaretFlash.of(null) });
  }, FLASH_MS);
}
```

样式是关键帧：

```css
/* src/components/editor/CodeEditor.module.css:239-241 — 当前 */
.wrap :global(.cm-line).caretFlash {
  animation: caretLandFlash 1.6s var(--ease-out) forwards;
}
```

「跳到结尾」**总是**落在同一个位置（`doc.length`），CodeMirror 复用同一个
`.cm-line` DOM 节点，类名一直在上面 → **1.6s 内第二次按「跳到结尾」什么都不闪**。
而按该文件 `:236-238` 的注释，这条提示是「光标被静默搬到文末」的**唯一**告知。

### 二、阅读模式「改完那节」的淡染

```tsx
/* src/components/lore/LoreDetail.tsx:185-190 — 当前 */
  const triggerFlash = (id: string) => {
    if (useLoreStore.getState().detailMode !== "read") return;
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashId(id);
    flashTimer.current = setTimeout(() => setFlashId(null), 1500);
  };
```

连续两次保存**同一个**特征：`setFlashId(id)` 传入的值与 state 已有的值相同，
React 直接跳过重渲染，`.flash` 类从未离开元素，`sectFlash` 不重播。
第二次保存**静默地没有回执**——而那恰恰是最需要回执的一次（作者刚刚在修
自己刚修过的东西）。`clearTimeout` 确实延长了窗口，所以不是"卡住不消失"的 bug，
纯粹是**不重播**。

## Target

两处都用同一个处方：**先清空、下一帧再设回**，让类名真正离开元素一帧。

```ts
/* target — src/lib/editor/caretFlash.ts */
export function flashCaretLanding(view: EditorView, pos: number): void {
  const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
  if (pending !== null) window.clearTimeout(pending);
  // 先摘掉再下一帧挂回：CSS 动画在类名已存在时不会重启，而「跳到结尾」总是
  // 落在同一行（doc.length），CodeMirror 复用同一个 .cm-line 节点——不清一次
  // 的话 1.6s 内的第二次跳转一帧都不闪，而这条色带是光标被搬走的唯一告知。
  view.dispatch({ effects: setCaretFlash.of(null) });
  window.requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    view.dispatch({ effects: setCaretFlash.of(clamped) });
  });
  pending = window.setTimeout(() => {
    pending = null;
    // The view may already be gone (file switch, project close) — check
    // before dispatching into a destroyed editor.
    if (view.dom.isConnected) view.dispatch({ effects: setCaretFlash.of(null) });
  }, FLASH_MS);
}
```

```tsx
/* target — src/components/lore/LoreDetail.tsx */
  const triggerFlash = (id: string) => {
    if (useLoreStore.getState().detailMode !== "read") return;
    if (flashTimer.current) clearTimeout(flashTimer.current);
    // 先置 null 再下一帧设回，否则连续两次保存同一节时 setFlashId 拿到相同值、
    // React 跳过重渲染，.flash 类从未离开元素，sectFlash 不重播——第二次保存
    // 静默无回执。同 ProvidersModelsPane.tsx:90 的既有处方。
    setFlashId(null);
    requestAnimationFrame(() => setFlashId(id));
    flashTimer.current = setTimeout(() => setFlashId(null), 1500);
  };
```

## Repo conventions to follow

**仓库里已经有一份写对了的**，逐字照抄它的思路与注释体例：

```tsx
/* src/components/settings/panes/ProvidersModelsPane.tsx:88-92 — 已有，正确 */
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      // Null first so moving the same row twice restarts the animation.
      setFlashId(null);
      requestAnimationFrame(() => setFlashId(id));
```

## Steps

1. `src/lib/editor/caretFlash.ts` —— 按 Target 改写 `flashCaretLanding`：
   在原来的 `view.dispatch({ effects: setCaretFlash.of(clamped) })` 之前插入一次
   `setCaretFlash.of(null)` 的 dispatch，把设值那次移进 `requestAnimationFrame`，
   并在 rAF 回调里加 `view.dom.isConnected` 守卫（与既有超时回调同理——
   跳转后立刻切文件会让 view 消失）。
2. 同文件 —— `pending` 超时的那次清除**保持不变**（它仍然是 1.6s 后摘掉类名的那一次）。
3. `src/components/lore/LoreDetail.tsx:185-190` —— 按 Target 在 `setFlashId(id)`
   之前插入 `setFlashId(null)`，并把设值移进 `requestAnimationFrame`。
4. 两处都写入 Target 里的注释——**没有注释的话下一个人会把这两行"化简"掉**，
   而化简之后的失效是静默的。

## Boundaries

- **不要**改 `FLASH_MS`（1.6s）或 `1500`ms 这两个时长，也不要改
  `CodeEditor.module.css` / `LoreReadView.module.css` 里任何关键帧。
- **不要**把关键帧改写成 `transition`。那确实能天然重定向（AUDIT §4 的一般建议），
  但这两处都是「从有色渐隐到透明」的一次性衰减，`transition` 需要一个持续存在的
  目标态，改写会牵动 reduced-motion 那两支的静态色带
  （`CodeEditor.module.css:251-255`），**收益不抵风险**。
- **不要**动 `CodeEditor.module.css:251-255` 的 reduced-motion 覆盖——
  它是全库唯一一个用 `!important` 正确压过全局归零的静态色带，是范本不是问题。
- **不要**改 `ProvidersModelsPane.tsx`，它已经是对的。
- 若代码与摘录对不上（自 43b52e9 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿；`pnpm build` 成功。
  - 若 `src/lib/__tests__/` 下存在 caretFlash 相关测试，一并保持全绿；
    本改动引入 rAF，若某测试同步断言了 dispatch 结果，**停下并报告**
    （处理方式参考方案 034：把 rAF 做成可注入的，而不是删测试）。
- **目检**（`pnpm tauri dev`，打开一份长文档）：
  - **连按两次**编辑器底栏的「跳到结尾」，两次之间不超过 1.6s：
    **第二次也必须闪**。改动前第二次一帧都不闪——这是本方案的核心判据。
  - 单次「跳到结尾」的观感应与改动前**完全一致**（1.6s 暖色带渐隐），
    不应看到闪烁前多出一帧空白。
  - 开系统「减弱动态效果」再连按两次：应看到静态色带出现并在 1.6s 后消失，
    第二次同样有反应。
  - 知识库某条目进阅读模式（`R`），**连续两次保存同一个特征**：
    第二次也应出现淡染。改动前第二次静默。
  - 保存**不同**特征交替两次：两次都应各自淡染（回归，确认没改坏原有路径）。
- **Done when**：两处的「同一目标连续触发两次」都能重播，单次观感不变。
