# 012 — 「插入到文档」的落点反馈（编辑器高亮闪烁）

- **Status**: DONE (2026-08-22)
- **Commit**: 9e16885
- **Severity**: LOW（加法项，审计「遗漏机会」M3；本批唯一的新增功能件）
- **Estimated scope**: 新建 1 个 lib 文件（~70 行）+ CodeEditor.tsx 接线 + AiPanel.tsx 两处调用

## Problem

「插入到文档」是一次点击里的双重硬切（`AiPanel.tsx:1097-1107` `handleApply`）：生成文本无声落进 CodeMirror——`replaceRange` 分支还会**覆盖作者自己的文字**而不留任何痕迹——同时 `clearOutput()` 让结果面板同帧清空。高风险、空间上跨面板（AI 面板→编辑器）的动作，零反馈。

仓库已有全部所需基建：

- **装饰扩展的完整样板**：`src/lib/editor/aiTarget.ts` —— StateEffect + StateField + `Decoration.mark` + `EditorView.baseTheme`，由 `CodeEditor.tsx:25-32` 引入、挂进扩展数组。
- **外部触达编辑器视图的既定通道**：`useEditorStore.getState().editorView`（先例：`consistencyStore.ts:222-236` 的 `locate`，取 view、dispatch selection + `scrollIntoView: true`）。
- **高亮色令牌**：`--color-mention-bg`（tokens.css，正文里的 lore 提及底色——语义就是「文中被指出的一段」）。

## Target

新建 `src/lib/editor/insertFlash.ts`，仿 `aiTarget.ts` 的结构：

```ts
/** 「插入到文档」的落点反馈：给刚写入的区间一段渐隐的高亮。
 *  结构仿 aiTarget.ts（StateEffect + StateField + mark decoration）。 */
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

const setFlash = StateEffect.define<{ from: number; to: number } | null>();

const flashMark = Decoration.mark({ class: "cm-insert-flash" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        deco = e.value
          ? Decoration.set([flashMark.range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* 渐隐靠 CSS animation：mark 元素挂类即播，播完保持透明；
   1.6s 后 dispatch 清除 effect 摘掉装饰本身。 */
const flashTheme = EditorView.baseTheme({
  "@keyframes cm-insert-flash-fade": {
    from: { backgroundColor: "var(--color-mention-bg)" },
    to: { backgroundColor: "transparent" },
  },
  ".cm-insert-flash": {
    animation: "cm-insert-flash-fade 1.6s var(--ease-out) forwards",
  },
});

export const insertFlashExtension = [flashField, flashTheme];

/** 高亮 [from, to) 并滚动到落点。范围会被 clamp 到当前文档长度。 */
export function flashInserted(view: EditorView, from: number, to: number): void {
  const len = view.state.doc.length;
  const f = Math.max(0, Math.min(from, len));
  const t = Math.max(f, Math.min(to, len));
  if (t === f) return;
  view.dispatch({
    effects: [setFlash.of({ from: f, to: t }), EditorView.scrollIntoView(f, { y: "center" })],
  });
  window.setTimeout(() => {
    // 视图可能已销毁（切文件/关项目）——dispatch 前判活。
    if (view.dom.isConnected) view.dispatch({ effects: setFlash.of(null) });
  }, 1600);
}
```

`CodeEditor.tsx`：把 `insertFlashExtension` 加进创建 EditorState 的扩展数组（与 `aiTargetExtension` 并列的位置）。

`AiPanel.tsx` `handleApply`（现状见 :1097-1107）：两个分支在 `setContent(...)` 之后、`clearOutput()` 之前各加一次调用：

```ts
// replaceRange 分支：新文本落在 [replaceRange.from, replaceRange.from + output.length)
// 续写分支：落点由 spliceContinuation 决定 —— 插入起点是
//   continueAnchor ?? content.length（若 spliceContinuation 会补分隔空行，
//   读该函数确认实际偏移；拿不准就 flash [起点, 起点 + output.length)，
//   clamp 已兜底）。
const view = useEditorStore.getState().editorView;
if (view) flashInserted(view, from, to);
```

注意 `setContent` → CodeMirror 内容更新可能是异步一拍（store → props → dispatch）。若 flash 时文档还是旧文本导致范围不对：把 `flashInserted` 调用包进 `requestAnimationFrame`（仓库先例：`AgentChat.tsx:198` 的一次性 post-layout rAF）。执行时实测决定是否需要。

## Repo conventions to follow

- 结构、命名、文件位置全部照 `src/lib/editor/aiTarget.ts`。
- 取 view 走 `useEditorStore.getState().editorView`（`consistencyStore.ts:225` 先例），**不要**新开通道。
- 颜色走 `--color-mention-bg` 令牌，两个主题下自动正确；曲线走 `--ease-out`。

## Steps

1. 新建 `src/lib/editor/insertFlash.ts`（上文完整代码为基准；对照 `aiTarget.ts` 的实际写法微调 import 与风格）。
2. `src/components/editor/CodeEditor.tsx`：import 并把 `insertFlashExtension` 加进扩展数组（紧邻 `aiTargetExtension`）。
3. `src/lib/context/` 里找到 `spliceContinuation`（AiPanel import 处可定位），读清楚它在锚点处是否插入分隔符，确定续写分支的 `[from, to)`。
4. `src/components/ai/AiPanel.tsx` `handleApply`：两分支按 Target 加 `flashInserted` 调用（必要时包 rAF）。
5. 实测两条路径（见 Feel check），若首帧范围错位则启用 rAF 包裹并复测。

## Boundaries

- 不改 `handleApply` 的写入逻辑与 `clearOutput()` 时机。
- 不做结果面板侧的动画（面板清空的软化不在本方案）。
- 装饰只有背景色——不加边框、不改字色，不干扰选区。
- reduced-motion 下这是纯颜色渐变（非位移），无需额外豁免；全局块会把它压成瞬时高亮→这可接受，不必对抗。
- 若 `handleApply` / `aiTarget.ts` 与摘录结构不符（相对 9e16885 有漂移），停下报告。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过。
- **Feel check**: `pnpm dev`，打开项目跑一次 AI 任务：
  - 续写→插入到文档：编辑器滚到落点，新文字带 `--color-mention-bg` 底色并在 1.6s 内渐隐。
  - 选中一段→改写→插入（replaceRange 路径）：被替换的区间同样高亮，作者能看到自己的文字被换成了什么。
  - 高亮渐隐期间继续打字：装饰随 `deco.map(tr.changes)` 跟着文本移动，不错位。
  - 插入后立刻切换文件再切回：无残留高亮、无控制台报错（`isConnected` 判活兜底）。
- **Done when**: 两条插入路径都有落点滚动 + 渐隐高亮，编辑与文件切换零回归。
