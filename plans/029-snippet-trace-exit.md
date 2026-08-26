# 029 — 提示词库痕迹行补上退场淡出（进出对称）

- **Status**: DONE (2026-08-26) — `pnpm exec tsc --noEmit` / `pnpm test`(190 文件·2563 用例) / `pnpm build` 全绿，构建产物已核验动画名未作用域化；**作者已在真 Tauri 窗口目检通过**。
- **Commit**: 1a72e2e
- **Severity**: MEDIUM
- **Category**: Physicality & origin（进出路径对称）
- **Estimated scope**: 2 files（1 个 .ts + 1 个 .module.css），约 15 行

## Problem

「已插入『冷处理改写』」这行确认痕迹**有进场、没退场**：淡入 240ms，然后在 1.6s / 2.4s 计时器到点的那一刻整行凭空消失。

```css
/* src/components/ai/SnippetPicker.module.css:62-68 — 现状：只有 fadeIn */
.trace {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  animation: fadeIn 240ms var(--ease-out);
}
```

```ts
// src/components/ai/snippetTrace.ts:47-56 — 现状：计时器到点直接置 null
export function showSnippetTrace(t: Omit<SnippetTrace, "seq">): void {
  if (timer) clearTimeout(timer);
  current = { ...t, seq: ++seq };
  emit();
  const mine = current.seq;
  timer = setTimeout(() => {
    // Only clear if nothing newer arrived — a second trace owns the screen.
    if (current?.seq === mine) { current = null; emit(); }
  }, HOLD_MS[t.kind]);
}
```

`SnippetTraceLine`（`SnippetPicker.tsx:384`）在 `trace` 为 null 时 `return null`，所以整个 `<span>` 直接从 DOM 消失。

**为什么重要**：这个功能的设计意图写在 `snippetTrace.ts:12-13` 的注释里 —— 「设计稿 1c⑤ / 1d①: no toast —— 确认是一条 hairline 和一个词，就地出现，一秒半后消失」。「消失」被实现成了「被切掉」。一个刻意做得安静的确认，退场时反而是全屏最硬的一次跳变 —— 眼角余光会被这个突变吸走，恰恰违背了不用 toast 的初衷。

（`.entryTraced` 那条 hairline 不在本计划范围内：`.entry` 已有 `transition: … box-shadow var(--transition-fast)`（`SnippetPicker.module.css:33-34`），类名移除时它本来就会淡掉 120ms。）

## Target

计时器拆成两段：`HOLD_MS` 到点后标记 `leaving`，再等 160ms 才真正卸载；这 160ms 里 CSS 播 `fadeOut`。

```ts
/* target — src/components/ai/snippetTrace.ts */

/** 退场淡出的时长，必须与 SnippetPicker.module.css 的 .trace.traceLeaving 一致。 */
const LEAVE_MS = 160;

export function showSnippetTrace(t: Omit<SnippetTrace, "seq">): void {
  if (timer) clearTimeout(timer);
  current = { ...t, seq: ++seq };
  emit();
  const mine = current.seq;
  timer = setTimeout(() => {
    // Only clear if nothing newer arrived — a second trace owns the screen.
    // 写成显式 null 判断而不是 `current?.seq !== mine`：后者虽然也能让 TS 收窄，
    // 但下一行要展开 current，判断写死更不容易在改动中失效。
    if (current === null || current.seq !== mine) return;
    // 先标记退场、让 CSS 淡出，160ms 后才真的卸载。直接置 null 会把一条
    // 刻意做得安静的确认切掉，退场反而成了全屏最硬的一次跳变。
    current = { ...current, leaving: true };
    emit();
    timer = setTimeout(() => {
      if (current?.seq === mine) { current = null; emit(); }
    }, LEAVE_MS);
  }, HOLD_MS[t.kind]);
}
```

```css
/* target — src/components/ai/SnippetPicker.module.css，紧跟 .trace 之后 */
.trace.traceLeaving {
  animation: fadeOut 160ms var(--ease-out) forwards;
}
```

## Repo conventions to follow

- `fadeOut` 是 `src/styles/global.css:95-97` 里已有的全局关键帧，**不要重新定义**：
  ```css
  @keyframes fadeOut {
    to { opacity: 0; }
  }
  ```
- **样板**：`src/styles/global.css:102-109` 的 `.modal-closing` —— 全 app 既有的「先标记退场、播完再卸载」模式，用的正是 `animation: fadeOut 160ms var(--ease-out) forwards`。160ms 这个数字直接沿用它，不要另选。
  ```css
  /* ModalShell 关闭中：整层淡出、面板轻微收缩；期间吞掉输入。 */
  .modal-closing {
    animation: fadeOut 160ms var(--ease-out) forwards;
    pointer-events: none;
  }
  ```
- 缓动 token：`src/styles/tokens.css:47` 的 `--ease-out`。只用 token 名。
- 选择器写成 `.trace.traceLeaving`（特异度 0,2,0）而不是单独的 `.traceLeaving`（0,1,0）：后者与 `.trace` 同特异度，胜负取决于文件内的源码顺序，脆弱。
- **模块 CSS 引用 global.css 的 keyframes 是可行的**：这条曾经静默失效（`docs/issues/css-modules-global-keyframes.md`），已于 2026-08-23 随 `vite.config.ts` 切 LightningCSS 修复并复核生效。**不要**因为担心作用域而把关键帧复制进本模块 —— 模块内的 `@keyframes` 现在与 global.css 共用一个全局命名空间，重名会互相覆盖，这正是方案 019 要守的不变量。
- 这个模块**刻意不进 zustand**（理由见 `snippetTrace.ts:6-13`：这是带计时器的临时 chrome，不是应用状态）。**保持它是模块级 emitter + `useSyncExternalStore`**，不要顺手搬进 store。
- 全局 `prefers-reduced-motion`（`src/styles/global.css:122-129`）会把淡出压到 `0.001ms`，即瞬间消失，但 JS 的 160ms 卸载延迟仍在。结果是「看不见的 160ms 空窗」—— 无害，**不要**为此加媒体查询或改 JS 时序。

## Steps

1. **`src/components/ai/snippetTrace.ts`** — 在 `SnippetTrace` 接口里，`seq` 字段**之前**新增一个可选字段：
   ```ts
     /** 退场中：CSS 播完淡出才真正卸载。见 showSnippetTrace 的两段计时器。 */
     leaving?: boolean;
   ```

2. **同一文件，`HOLD_MS`（第 36 行）之后**新增常量：
   ```ts
   /** 退场淡出的时长，必须与 SnippetPicker.module.css 的 .trace.traceLeaving 一致。 */
   const LEAVE_MS = 160;
   ```

3. **同一文件，`showSnippetTrace`（第 47-56 行）** — 按上面 Target 的 ts 块整体替换函数体。
   `clearSnippetTrace`（第 58-62 行）**不需要改**：它开头的 `if (timer) clearTimeout(timer)` 对两段计时器都有效（第二段计时器赋值给同一个 `timer` 变量）。
   `showSnippetTrace` 开头的 `clearTimeout` 同理 —— 新痕迹到达时，无论旧的处在哪一段都会被干净地打断。

4. **`src/components/ai/SnippetPicker.module.css`** — 在 `.trace` 规则块（第 62-68 行）**之后**新增：
   ```css
   /* 退场：进场有淡入，退场就不能是切掉。160ms 与 global.css 的 .modal-closing
      同档——全 app「先标记退场、播完再卸载」用的是同一个数。 */
   .trace.traceLeaving {
     animation: fadeOut 160ms var(--ease-out) forwards;
   }
   ```

5. **`src/components/ai/SnippetPicker.tsx:392`** — 给痕迹行的 `<span>` 挂上退场类名：
   ```tsx
       <span className={`${styles.trace} ${trace.leaving ? styles.traceLeaving : ""}`}>
   ```
   该行其余内容（三个子 `<span>`）原样不动。

## Boundaries

- 不要修改 `HOLD_MS` 的两个值（`saved: 1600` / `inserted: 2400`）—— 那是设计稿定的停留时长，本次只在它之后**追加**退场段。
- 不要修改 `clearSnippetTrace`、`useSnippetTrace`，或 `SnippetTrace` 的其余任何字段。
- 不要动 `SnippetTraceLine` 里的 ⌘Z `useEffect`（`SnippetPicker.tsx:369-382`）。它的依赖是 `[trace?.seq, trace?.undo]`，而标记 `leaving` 时 `seq` 与 `undo` 引用都不变 —— 监听器不会重挂。**副作用**：撤销快捷键在淡出的 160ms 里仍然有效，这是可接受的宽限期，不要试图掐掉它。
- 不要动 `.entryTraced`（第 60 行）或 `.entry` 的 transition —— hairline 已经会自己淡掉。
- 不要把这个模块搬进 zustand（理由见上面 conventions）。
- 不要新增 `@keyframes`，`fadeOut` 已存在。不要新增依赖。
- 若代码与上面的摘录对不上（自 1a72e2e 起有漂移），**停下来报告**。

## Verification

- **Mechanical**：
  - `pnpm tsc --noEmit` —— 无报错（新增的 `leaving?: boolean` 是可选字段，`showSnippetTrace` 的入参类型 `Omit<SnippetTrace, "seq">` 因此仍兼容所有现有调用点）。
  - `pnpm test` —— 全绿。
  - `git diff --stat` 应只显示三个文件：`snippetTrace.ts`、`SnippetPicker.module.css`、`SnippetPicker.tsx`。
- **Feel check**：`pnpm tauri dev`，打开 AI 抽屉，找到底部的提示词库入口。
  - **存入**：在编辑器里选中一段文字，右键存入提示词库。确认「已存入『未分组』」淡入，停留约 1.6s，然后**淡出**约 1/6 秒 —— 不是切掉。
  - **插入**：从提示词库取用一条。确认「已插入『…』」停留约 2.4s 后同样淡出。
  - **中途打断**：在第一条痕迹**正在淡出**的那 160ms 里再触发一次存入。确认新痕迹**立刻以全不透明淡入**接管，没有卡在半透明、没有闪烁、没有两行叠在一起。这是本计划最容易出错的一处。
  - **hairline**：确认入口下方那条赭石细线与文字**同时**开始消退（`.entry` 的 box-shadow transition 是 120ms，文字是 160ms，两者应看起来是一起走的，不该出现文字没了线还在的空档）。
  - **⌘Z**：插入后立刻按 ⌘Z，确认撤销照常生效。
  - DevTools → Animations 面板，播放速度 10%，确认退场是纯 opacity 从 1 到 0，没有位移、没有尺寸变化（`forwards` 保证它停在 0 而不是回弹到 1）。
  - DevTools → Rendering → 勾选 `prefers-reduced-motion: reduce`，确认痕迹到点后瞬间消失，且**不会**留下一个 160ms 的透明占位把旁边的内容撑开（`.trace` 是 `inline-flex`，透明度为 0 时仍占位 —— 确认这 160ms 里布局不跳）。
- **Done when**：痕迹进出对称淡入淡出；淡出途中被新痕迹打断能干净接管；⌘Z 仍有效；布局全程不跳。
