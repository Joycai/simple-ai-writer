# 011 — 状态变化软化：保存指示、视图切换、草稿切换

- **Status**: DONE (2026-08-22)
- **Commit**: 9e16885
- **Severity**: LOW（加法项，审计的「遗漏机会」M1/M2/M4）
- **Estimated scope**: 3 个 CSS 文件 + 1 个 TSX 属性，~8 行

## Problem

三处高价值的状态变化目前是一帧硬切：

**A. 保存指示圆点**（M4）——琥珀↔绿一帧跳变，是写作者唯一的落盘确认，一闪即过容易漏看：

```css
/* src/components/layout/TitleBar.module.css:110-116 — 现状 */
.saveDot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.saveDotSaved { background: var(--color-success); }
.saveDotDirty { background: var(--color-warning); }
```
（由 `TitleBar.tsx:147` 的 `isDirty ? styles.saveDotDirty : styles.saveDotSaved` 驱动。高频状态，**只做颜色过渡，绝不做位移**。）

**B. 编辑/分栏/预览切换**（M1）——全应用最常用的布局操作，也是唯一不动画的视图变化：新窗格满渲染地在同一帧砸进来（`EditorArea.tsx:144-162`，`showEditor`/`showPreview` 布尔挂载，`EditorArea.module.css` 的 `.editorPane`/`.previewPane` 无任何动画）。

**C. AI 多稿切换**（M2）——点「版本 2」时最多 420px 的正文一帧瞬换，没有任何「哪段是新的」信号（`AiPanel.tsx:1923-1927` 的 `.output` div 无 key 无过渡，React 原地 reconcile 文本）。这正是多稿功能存在的比较时刻。

## Target

**A**：给圆点加颜色过渡（保存文字标签随 React 重渲瞬换，可接受——颜色是主信号）：

```css
/* TitleBar.module.css — 目标 */
.saveDot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  transition: background var(--transition-base);
}
```

**B**：新挂载的窗格做 160ms 纯透明度入场（不动布局——宽度重排无法体面地动画，淡入足以垫住硬切）：

```css
/* EditorArea.module.css — 目标：.editorPane 与 .previewPane 各追加一行 */
  animation: fadeIn 160ms var(--ease-out);
```
（`fadeIn` 是 `global.css` 的共享帧。窗格在文件切换时不重挂载，只在视图模式改变时挂载，不会高频重放。）

**C**：`.output` 按稿件 id 加 key（切稿=重挂载），配 120ms 淡入；流式期间同 key 重渲不触发动画：

```tsx
// AiPanel.tsx:1924 — 目标
              <div className={styles.output} ref={outputRef} key={activeDraft?.id}>
```
```css
/* AiPanel.module.css — 目标：.output 规则追加一行 */
  animation: fadeIn 120ms var(--ease-out);
```

## Repo conventions to follow

- `fadeIn` 共享帧在 `global.css`；模块引用未本地声明的动画名透传到全局（先例：ConfirmDialog 等全部模态）。
- 时长取令牌刻度内的值：颜色 200ms（`--transition-base` 语义）、窗格 160ms、文本交换 120ms——都在 UI 预算内。
- 「高频状态只变颜色不位移」是审计准则 §1 的直接应用。

## Steps

1. `src/components/layout/TitleBar.module.css`：`.saveDot` 追加 `transition: background var(--transition-base);`。顺带检查 `.crumbState`（约 :76-80，面包屑里的另一个状态色）——若也是纯色跳变，加同款 `transition: color var(--transition-base);`。
2. `src/components/layout/EditorArea.module.css`：`.editorPane` 与 `.previewPane` 各追加 `animation: fadeIn 160ms var(--ease-out);`。
3. `src/components/ai/AiPanel.tsx`：`.output` div（约 :1924，`ref={outputRef}` 所在元素）加 `key={activeDraft?.id}`。
4. `src/components/ai/AiPanel.module.css`：`.output` 规则追加 `animation: fadeIn 120ms var(--ease-out);`。

## Boundaries

- 不动视图切换的布局逻辑、不引入 Motion、不给窗格加位移动画。
- 保存指示的文字部分不动画。
- `.output` 的滚动行为（`outputRef` 的自动滚动）不动——key 变化会重置滚动位置到顶部，这正是切稿时想要的（新稿从头读）。
- 若某处与摘录不符（相对 9e16885 有漂移），停下报告。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过。
- **Feel check**: `pnpm dev`：
  - 编辑器里打字→停止触发自动保存：圆点琥珀→绿应有 200ms 的颜色渐变，肉眼能捕捉到「刚刚保存了」。
  - 工具栏切换 编辑/分栏/预览：新窗格 160ms 淡入，不再一帧砸入；快速连点无闪烁堆积。
  - 生成多稿后点另一个版本 tab：新文本 120ms 淡入，能感知「内容换了」；流式生成期间输出区**不**闪（同 key 重渲不触发动画）。
- **Done when**: 三处状态变化都有可感知但不喧宾的过渡，流式与打字路径零回归。
