# 034 — 分屏滚动联动合并到 rAF（每个 scroll 事件强制同步布局）

- **Status**: DONE（门禁已过，目检待作者）
- **Commit**: 43b52e9
- **Severity**: MEDIUM
- **Category**: 5 性能
- **Estimated scope**: 1 个 TS 文件 + 1 个测试文件

> ⚠ **先读 Boundaries 里关于测试的那条**：本模块有单元测试，且测试是
> **同步**断言的。天真地加 rAF 会打挂 8 条断言。rAF 必须像既有的
> `setTimeout`/`clearTimeout` 一样可注入。

## Problem

`src/lib/editor/scrollSync.ts:186-232` —— 当前代码（节选）：

```js
  const follow = (
    from: Scrollable,
    to: Scrollable,
    fromMap: ScrollMapping | undefined,
    toMap: ScrollMapping | undefined,
  ) => () => {
    if (detached) return;
    if (driver && driver !== from) return;
    driver = from;

    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    …
        let mapped = false;
        if (fromMap && toMap) {
          const line = fromMap.lineAtTop();
          if (line !== null) mapped = toMap.scrollToLine(line);
        }
        if (!mapped) to.scrollTop = (from.scrollTop / fromMax) * toMax;
```

注册时**没有任何节流**：

```js
/* src/lib/editor/scrollSync.ts:229-232 — 当前 */
  const onA = follow(a, b, options.mapA, options.mapB);
  const onB = follow(b, a, options.mapB, options.mapA);
  a.addEventListener("scroll", onA, { passive: true });
  b.addEventListener("scroll", onB, { passive: true });
```

macOS 触控板的 `scroll` 事件可达 **120/s**，与显示刷新率无关。每一个事件都同步地：

1. **读**两个面板的 `scrollHeight` / `clientHeight`；
2. 调 `lineAtTop()` —— 编辑器侧是 `view.scrollDOM.getBoundingClientRect()` +
   `view.lineBlockAtHeight()`（`src/lib/editor/scrollAnchors.ts:25-33`），
   预览侧是 `scroller.getBoundingClientRect()` 加一串 O(log n) 的
   `getBoundingClientRect()` 探测（`scrollAnchors.ts:100-113`）；
3. **写** `to.scrollTop`。

读—写交替横跨两棵子树，**强制同步布局**（layout thrashing）；而一帧之内
只有最后一次写是可见的，其余全是浪费。分屏滚动在 100+/天 那一档。

## Target

把每个滚动事件里的**测量与写入**合并到下一帧，只保留最新一次：

```ts
/* target — src/lib/editor/scrollSync.ts */

// 在 linkScrollers 的选项解析处（与既有 setT/clearT 并列）新增可注入的 rAF。
// 可注入的理由与 setTimeout 完全相同：单元测试跑在 node 环境、用假元素同步
// 驱动，真 rAF 会让所有断言在事件回合结束前拿不到结果。
const raf = options.requestAnimationFrame ?? ((fn: () => void) => window.requestAnimationFrame(fn));
const cancelRaf = options.cancelAnimationFrame ?? ((h: number) => window.cancelAnimationFrame(h));

// follow() 内部：把原来的函数体整体挪进一个 run()，事件回调只负责排帧。
const follow = (from, to, fromMap, toMap) => {
  let frame: number | null = null;
  const run = () => {
    frame = null;
    /* …原来 follow 回调的函数体，一字不改… */
  };
  return () => {
    if (detached) return;
    if (driver && driver !== from) return;
    // 同一帧内的后续滚动事件覆盖前一次：只有最后一次的位置需要被镜像。
    if (frame !== null) cancelRaf(frame);
    frame = raf(run);
  };
};
```

`LinkScrollOptions` 相应新增两个可选字段：

```ts
/* target — LinkScrollOptions 类型定义处 */
  /** 可注入的 rAF —— 与 setTimeout/clearTimeout 同理，供单元测试同步驱动。 */
  requestAnimationFrame?: (fn: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
```

清理函数里补一句取消未决帧。

## Repo conventions to follow

- **本仓库已有这个形状的正确范本**，就在阅读模式的滚动侦测里：
  ```tsx
  /* src/components/lore/LoreReadView.tsx:188-191 — 已有，正确 */
    const onScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateActive);
    };
  ```
- **依赖注入的体例已经在同一个函数里**，照抄它：
  ```ts
  /* src/lib/editor/scrollSync.ts:176-178 — 已有 */
    const releaseMs = options.releaseMs ?? 80;
    const setT = options.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
    const clearT = options.clearTimeout ?? ((h) => window.clearTimeout(h));
  ```
- 另一个 rAF 合并的范本（拖拽侧栏，方案 021 落地）：`src/App.tsx:50-75`。

## Steps

1. `src/lib/editor/scrollSync.ts` —— 在 `LinkScrollOptions` 类型里新增
   `requestAnimationFrame?` / `cancelAnimationFrame?` 两个可选字段，带上
   Target 里的注释。
2. 同文件 `linkScrollers` 顶部（`:176-178` 那三行旁边）解析出 `raf` / `cancelRaf`，
   默认走 `window`。
3. 同文件 —— 改造 `follow`：把现有回调体整体移入内部的 `run()`，
   返回的事件处理器只做「`detached`/`driver` 短路 → 取消上一帧 → 排新帧」。
   **`driver = from` 这一句要留在事件处理器里、不要挪进 `run()`**——
   回声抑制必须在事件到达的**当下**生效，否则同一帧内对侧的事件会被当成用户驱动。
4. 同文件 —— 在 `linkScrollers` 返回的清理函数里，`detached = true` 之后取消两个
   `follow` 的未决帧。最简做法：让 `follow` 额外返回一个 `cancel()`，
   或把 frame 句柄提到闭包外层用两个变量存。选一种，写清楚即可。
5. `src/lib/__tests__/scrollSync.test.ts` —— 在 `manualTimers()` 返回的 `opts` 里
   补上**同步**的 rAF：
   ```ts
   requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
   cancelAnimationFrame: () => {},
   ```
   这样既有的同步断言（`a.scrollTop = 750; expect(b.scrollTop).toBe(2250);`）
   全部保持通过，且测试仍然测的是真实的映射逻辑。
6. 同测试文件 —— **新增一条断言**证明合并确实发生：用一个计数 rAF
   （记录被排帧的次数、手动 flush），在一个回合内连续写三次 `from.scrollTop`，
   断言 `run` 只执行一次、且 `to.scrollTop` 是最后一次的映射结果。

## Boundaries

- **不要**改动 `follow` 内部的映射数学、极值吸附（`scrollTop <= 0` /
  `>= fromMax - 1`）、`fromMax > 0 && toMax > 0` 的除零保护，或 `release`
  回声抑制的时长。本方案**只改调度时机**，不改行为。
- **不要**用 `setTimeout(…, 16)` 或 lodash 式 throttle 代替 rAF。
- **不要**删除或放宽既有测试来「让它通过」。若某条断言在正确实现下失败，
  **停下并报告**——那说明第 3 步的 `driver` 归属搞错了。
- **不要**碰 `src/lib/editor/scrollAnchors.ts`（`lineAtTop` / `scrollToLine`
  的实现）——它们的开销是本方案要**少调用**的对象，不是要改写的对象。
- 若代码与摘录对不上（自 43b52e9 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `pnpm test src/lib/__tests__/scrollSync.test.ts` —— 既有断言全绿 + 新增的
    合并断言通过。**这是本方案最重要的门禁。**
  - `pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全量全绿；`pnpm build` 成功。
- **目检**（`pnpm tauri dev`，打开一份**长文档**并切到分屏 editor|preview）：
  - 用触控板在编辑器侧快速惯性滚动：预览侧应仍然跟随，**不应**出现跟随滞后、
    抖动或来回弹跳（后者说明 `driver` 归属被挪错了帧）。
  - 反向从预览侧驱动，同样检查一遍。
  - 滚到最顶和最底：两侧应仍然精确对齐两端（极值吸附未被破坏）。
  - DevTools Performance 录制 3 秒惯性滚动：改动前每个 scroll 事件下方挂着
    Layout；改动后每帧至多一次。**这是唯一能量化的判据。**
- **Done when**：测试全绿（含新增的合并断言），分屏跟随行为与改动前一致，
  Performance 面板里每帧的强制布局降到 ≤1 次。
