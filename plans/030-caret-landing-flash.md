# 030 — 「跳到结尾」的光标落点提示

- **Status**: DONE (2026-08-29) — 机械验证全部通过；**目检待作者**（Verification 里 Feel check 那一组需要真窗口 + 一份长文档，未执行）
- **Commit**: 5f9d25a
- **Severity**: LOW（加法项；来自 find-animation-opportunities 的「遗漏机会」）
- **Category**: 遗漏机会 / 状态指示
- **Estimated scope**: 新建 1 个 lib 文件（~60 行）+ CodeEditor.tsx 两处接线 + CodeEditor.module.css 一段样式 + EditorScrollNav.tsx 一行调用

## Problem

`EditorScrollNav` 的两颗按钮外观完全一样（同一个 `.btn` 样式、同一组 lucide
chevron），**行为却不对称**：

```tsx
// src/components/editor/EditorScrollNav.tsx:58-73 — 现状
  const toTop = () => {
    // Let CodeMirror scroll rather than scrollDOM.scrollTo({behavior:"smooth"}):
    // the editor only renders lines near the viewport, so a native smooth scroll
    // across the whole doc gets cancelled mid-flight as off-screen lines render
    // and shift scrollHeight. scrollIntoView measures correctly. Caret untouched.
    view.dispatch({ effects: EditorView.scrollIntoView(0, { y: "start" }) });
  };

  const toEnd = () => {
    const end = view.state.doc.length;
    view.dispatch({
      selection: { anchor: end },
      effects: EditorView.scrollIntoView(end, { y: "end" }),
    });
    view.focus();
  };
```

`toTop` 是**纯滚动**（注释明写 “Caret untouched”）。`toEnd` 却同时做了三件事：
滚动、把 anchor 挪到 `doc.length`、抢走焦点。也就是说作者点下去,**光标被静默搬走
了**——原本停在第三章某处的插入点没了,而界面上没有任何一处说出这件事。下一次
按 ⌘Z 或者随手敲一个字,落点都在文末。

仓库里唯一相关的既有提示是 `highlightActiveLine()`（`CodeEditor.tsx:172` 已注册）,
但它被**刻意调成了几乎看不见**:

```css
/* src/components/editor/CodeEditor.module.css:228-231 — 现状 */
/* Active line — barely-there warm tint, easy on the eyes */
.wrap :global(.cm-activeLine) {
  background: rgba(160, 82, 45, 0.04);
}
```

4% alpha 是对的——写作时一条常驻高亮会一直分散注意力。但这也意味着它**只能在你
已经看着它的时候告诉你光标在哪,无法在一次跨越几千像素的瞬移之后把视线接住**。
再加上 `y: "end"` 会把最后一行贴在视口底边,落点既不显眼也不居中。

所以缺的不是「滚动动画」（那条已被否掉,理由见下方 Boundaries），而是**落点的一次性
状态指示**。

## Target

新建 `src/lib/editor/caretFlash.ts`,结构仿 `insertFlash.ts`,但用
`Decoration.line` 而不是 `Decoration.mark`,并且**把类名作为参数传入**（照
`aiTargetExtension` 的约定,理由见下）:

```ts
/**
 * Caret-landing feedback: a fading band over the line the caret was just
 * moved to.
 *
 * `EditorScrollNav`'s "jump to end" silently relocates the caret and steals
 * focus, while its twin "jump to top" leaves the caret alone — two identical
 * buttons, two different contracts, and nothing on screen saying which just
 * happened. `highlightActiveLine` is tuned to 4% alpha so it does not nag
 * during writing, which also means it cannot catch the eye after a jump.
 *
 * A line decoration rather than `insertFlash`'s mark: the caret lands at
 * `doc.length`, and a document ending in a newline puts that on an EMPTY
 * line — a mark over a zero-width range paints nothing, while a line
 * decoration still gives the band its line-height.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

const setCaretFlash = StateEffect.define<number | null>();

/** How long the band stays before it is torn down. Matches insertFlash.ts. */
const FLASH_MS = 1600;

let pending: number | null = null;

function caretFlashField(className: string): StateField<DecorationSet> {
  const lineMark = Decoration.line({ class: className });
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      // Cleared on any edit rather than mapped forward: once the author types,
      // the cue has done its job and should get out of the way. Mapping would
      // also risk carrying a line decoration off a line start, which
      // CodeMirror rejects.
      if (tr.docChanged) deco = Decoration.none;
      for (const e of tr.effects) {
        if (e.is(setCaretFlash)) {
          deco = e.value === null
            ? Decoration.none
            : Decoration.set([lineMark.range(tr.state.doc.lineAt(e.value).from)]);
        }
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/**
 * Editor extension holding the landing band.
 *
 * @param className Class applied to the landing line. Passed in rather than
 *   hardcoded so the styling stays in the editor's own CSS module — the same
 *   reason `aiTargetExtension` takes one, and here also a correctness
 *   requirement: `.cm-activeLine` is styled from that module at a higher
 *   specificity than a `baseTheme` rule could reach.
 */
export function caretFlashExtension(className: string): Extension {
  return [caretFlashField(className)];
}

/** Paint the line containing `pos`, then tear it down. Does NOT scroll — the caller already did. */
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

样式与关键帧进 `src/components/editor/CodeEditor.module.css`（**不是** baseTheme,
理由见 Repo conventions）:

```css
/* target — 追加在 .cm-activeLine 规则之后 */

/* 「跳到结尾」的落点提示：光标被静默搬到文末，用一次渐隐的暖色带把视线接住。
   选择器带 :global(.cm-line) 是为了压过上面 .cm-activeLine 的背景——两条规则
   命中同一个元素，(0,3,0) 胜 (0,2,0)，不靠书写顺序。 */
.wrap :global(.cm-line).caretFlash {
  animation: caretLandFlash 1.6s var(--ease-out) forwards;
}

@keyframes caretLandFlash {
  from { background-color: var(--color-mention-bg); }
  to   { background-color: transparent; }
}

/* reduced-motion 下 global.css 会把 animation-duration 压到 0.001ms，动画那支
   等于一帧都不播——而这条提示本身就是「光标动了」的唯一告知，压没了就等于
   回到缺陷状态。所以这里换成不动的色带，由同一个 1.6s 定时器摘掉。 */
@media (prefers-reduced-motion: reduce) {
  .wrap :global(.cm-line).caretFlash {
    animation: none;
    background-color: var(--color-mention-bg);
  }
}
```

`CodeEditor.tsx` 扩展数组（现状 `:165-189`）在 `insertFlashExtension` 之后加一行:

```tsx
        aiTargetExtension(styles.aiTarget),
        insertFlashExtension,
        caretFlashExtension(styles.caretFlash),   // ← 新增
```

`EditorScrollNav.tsx` 的 `toEnd`,在既有 dispatch 之后、`view.focus()` 之前加一行:

```tsx
  const toEnd = () => {
    const end = view.state.doc.length;
    view.dispatch({
      selection: { anchor: end },
      effects: EditorView.scrollIntoView(end, { y: "end" }),
    });
    flashCaretLanding(view, end);
    view.focus();
  };
```

## Repo conventions to follow

- **结构、命名、文件位置照 `src/lib/editor/insertFlash.ts`**（同目录的兄弟件:
  `aiTarget.ts` / `aiSelection.ts` / `insertFlash.ts`,一个关注点一个文件）。
- **类名作为参数传入,样式留在 `CodeEditor.module.css`** —— 这是
  `src/lib/editor/aiTarget.ts:82-84` 明写的约定（“Passed in rather than hardcoded
  so the styling stays in the editor's own CSS module”）。本方案**必须**照它,而不
  是照 `insertFlash.ts` 的 `EditorView.baseTheme` 内联样式:`.cm-activeLine` 的规则
  是 `.wrap :global(.cm-activeLine)`（0,2,0）,而 baseTheme 注入的 `.cm-insert-flash`
  只有 (0,1,0)。动画播放期间靠 CSS 动画来源（animation origin）还能压过去,但
  **reduced-motion 那支是静态 background,会被 activeLine 直接盖掉、一片都看不见**
  —— 一个不报错的静默失败。放进模块 CSS 并写成 (0,3,0) 就整类消除了这个问题。
- **颜色走 `--color-mention-bg`**（`tokens.css:154` 亮色 `#F1E0BD` / `:434` 暗色
  `rgba(217, 146, 91, 0.32)`）。和 `insertFlash` 同一个色:两者说的是同一句话
  ——「你的视线该落在这里」——不该有两套视觉词汇。曲线走 `--ease-out`。
- **时长 1.6s 与 `insertFlash.ts:45` 一致。**不要改成 300ms:AUDIT 的
  <300ms 预算约束的是元素进出场的位移,而这是一条读完即弃的高亮衰减,仓库已经
  为同一语义定过 1.6s（方案 012,已 DONE）。
- **关键帧名全局唯一。**`src/lib/__tests__/cssKeyframeNames.test.ts` 会扫描全部
  `.css` 并断言重名为零 —— 把关键帧写进模块 CSS 正好让 `caretLandFlash` 落进这
  张网（`insertFlash` 的 `cm-insert-flash-fade` 在 `.ts` 里,反而是test 覆盖不到的
  那种）。若测试报重名,改名而不是改测试。

## Steps

1. 新建 `src/lib/editor/caretFlash.ts`,以 Target 一节的完整代码为基准;对照
   `insertFlash.ts` 与 `aiTarget.ts` 的实际写法微调 import 顺序与注释风格。
2. `src/components/editor/CodeEditor.module.css`:在 `.cm-activeLine` 规则
   （`:228-231`）之后追加 Target 里的三段（`.caretFlash` 规则、`@keyframes
   caretLandFlash`、reduced-motion 媒体查询）。
3. `src/components/editor/CodeEditor.tsx`:import `caretFlashExtension`,并在扩展
   数组 `insertFlashExtension`（`:178`）之后加 `caretFlashExtension(styles.caretFlash)`。
4. `src/components/editor/EditorScrollNav.tsx`:import `flashCaretLanding`,在
   `toEnd` 的 dispatch 之后、`view.focus()` 之前调用它。**`toTop` 不动。**
5. 跑 Verification 一节。

## Boundaries

- **不要给 `toTop` 加任何提示。**它不动光标,没有需要告知的状态变化;两颗按钮的
  区别正是本方案要说出来的那件事。
- **不要给这两颗按钮加平滑滚动。**已评估并否掉,三条理由:(a) CodeMirror 只渲
  染视口附近的行,跨全文的原生平滑滚动会因 `scrollHeight` 变动而中途取消
  ——`EditorScrollNav.tsx:60` 的注释就是踩过之后写的;(b) 一章几万像素在 300ms
  预算内是一片糊;(c) 唯一能平滑滚完的距离是「刚好溢出一点点」,而那种跳本来就
  不刺眼——动画只会在最不需要它的场合亮起。
- **不要改 `insertFlash.ts`**（包括它缺的 pending-timer 取消和它的 baseTheme 写
  法)。那是 012 已验收的件,不在本方案范围内。
- **不要改 `.cm-activeLine` 的 4% alpha。**那是刻意调低的常驻提示。
- **不要动 `EditorScrollNav` 的 `EDGE` 判定、按钮显隐逻辑或 `.btn` 样式。**
- 不加新依赖,不加新令牌。
- 若发现代码与本方案摘录不符（相对 `5f9d25a` 有漂移),**停下报告,不要即兴发挥**。

## Verification

- **Mechanical**:
  - `pnpm tsc --noEmit` 通过（注意:输出里出现 pnpm 的一次性 install 摘要属正常,
    以是否有 `error TS` 行和退出码为准,别只看退出码）。
  - `pnpm test` 通过 —— 特别是 `cssKeyframeNames.test.ts`,它会验
    `caretLandFlash` 没有和 global.css 的 12 个或其他模块的关键帧重名。
  - `pnpm build` 通过。
- **Feel check**:`pnpm dev`,打开一份**长到需要滚动**的文档（几千字以上）,把
  光标点在文档中部,滚到中间让两颗按钮都出现:
  - 点「跳到结尾」:视图滚到文末,**最后一行整行**浮起一层暖色带并在 1.6s 内渐
    隐,眼睛不用找就知道光标去了哪。
  - 让文档**以一个空行结尾**（末尾留一个换行）再点一次:空行同样有整行色带
    ——这是选 `Decoration.line` 而不是 mark 的唯一理由,mark 在这里会一片都不画。
  - 点「回到开头」:**没有任何色带**,光标留在原处。两颗按钮的差别肉眼可辨。
  - 色带还在渐隐时随手敲一个字:色带**立刻消失**（`tr.docChanged` 清空),不残
    留、不错位、不跟着文字漂。
  - 点完立刻切换到另一个文件再切回:无残留高亮、控制台无报错(`isConnected` 兜底)。
  - 落点行同时是 `.cm-activeLine`。确认**色带明显盖过那 4% 的底色**;如果看起来
    只是"稍微深了一点",说明特异性没压过去,回到第 2 步检查选择器写成了
    `.wrap :global(.cm-line).caretFlash` 而不是 `.wrap .caretFlash`。
  - DevTools → Rendering → 勾 `prefers-reduced-motion: reduce`,再点一次
    「跳到结尾」:色带**仍然出现**（不动、不渐隐),1.6s 后消失。**如果什么都没
    看到,说明媒体查询那段没生效——这正是本方案要防的静默失败。**
  - 亮色与暗色主题各跑一遍,确认 `--color-mention-bg` 在两边都看得见、都不刺眼。
- **需要作者拍板的一处**:整行色带比 `insertFlash` 的行内片段视觉上更"响"。若
  作者判断 1.6s 的整行band 在文末太抢眼,**唯一允许的调整是把
  `.wrap :global(.cm-line).caretFlash` 的时长从 `1.6s` 降到 `1s`**,颜色与曲线不
  动。执行者**不要自行**改这个值——先按 1.6s 交付,由作者目检后决定。
- **Done when**:「跳到结尾」有落点色带、「回到开头」没有;空行结尾与
  reduced-motion 两条边界都验过;`tsc` / `test` / `build` 三项通过,编辑与切换文件
  零回归。
