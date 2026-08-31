# 041 — 令牌归位与关键帧去重（第八批的 LOW 收敛批）

- **Status**: TODO
- **Commit**: 43b52e9（+ PR #430 的 031–040）
- **Severity**: LOW
- **Category**: 7 内聚与令牌 / 2 缓动
- **Estimated scope**: 6 个文件，机械批量，模式单一

体例同方案 022（005 的漏网之鱼）。七处，同一类修法：让**只有一份**的东西真的只有一份。

## Problem

### A. `--ease-out` 的控制点手打了三份

```css
/* src/styles/tokens.css:47 — 真相 */
  --ease-out:    cubic-bezier(0.32, 0.72, 0, 1);
```
```ts
/* src/lib/motion.ts:30 — 当前，注意是 const 不是 export const */
const EASE_OUT: [number, number, number, number] = [0.32, 0.72, 0, 1];
```
```ts
/* src/components/layout/RecentProjects.tsx:34 — 当前 */
const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];
```

TS↔CSS 的那次跨越（`motion.ts:30`）不可避免，且带着「keep in step with tokens.css」
的注释。**第三份不是**：`RecentProjects.tsx` 只能自己再抄一遍，因为
`motion.ts` 的 `EASE_OUT` **没有导出**。于是重调一条曲线要同时改三处，
而 JS 侧没有任何测试守着这个漂移。

### B. 全库仅有的四条裸 `ease`

```css
/* src/components/settings/panes/DocFormat.module.css:82,595,604,802 — 当前 */
 82:  transition: background 140ms ease, box-shadow 140ms ease;
595:  transition: background 140ms ease, border-color 140ms ease;
604:  transition: transform 140ms ease, background 140ms ease;
802:  transition: opacity 120ms ease;
```

全仓库其余每一条 `transition:` 都走 `var(--transition-*)` 或 `var(--ease-out)`。
`:604` 尤其错：它是开关旋钮的**位移**（`:608` 的 `transform: translateX(14px)`），
按缓动决策顺序，移动该用 `--ease-out`，而裸 `ease` 是对称的、起手慢。

**注意两种情况要分开修**（这是本方案唯一需要动脑的地方）：
- `140ms` **不是**任何令牌的时长，所以只换曲线：`140ms var(--ease-out)`。
  强行改成 `--transition-fast`（120ms）会顺手改掉三处控件的节奏，超出本方案范围。
- `:802` 的 `120ms ease` **恰好**就是 `--transition-fast`（`tokens.css:52` =
  `120ms var(--ease-out)`），整条换成令牌。

### C. 两处把 `--transition-fast` 手工展开

```css
/* src/components/ai/SnippetPicker.module.css:220 — 当前 */
  transition: background 120ms var(--ease-out);
/* src/components/roleplay/RoleplayChat.module.css:231 — 当前 */
  transition: opacity 120ms var(--ease-out), color 120ms var(--ease-out);
```
全库仅有的两条把令牌拆开重写的声明——B 类漂移正是从这种缝里开始的。

### D. `writerPulse` 与全局 `pulseDeep` 是同一个动画

```css
/* src/components/ai/WriterTurn.module.css:390-396 — 当前 */
  animation: writerPulse 1.4s infinite;
…
@keyframes writerPulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
```
```css
/* src/styles/global.css:94-98 — 已有 */
/* 深谷值脉冲 — 直播状态圆点（扮演花名册/流式指示）用 */
@keyframes pulseDeep {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
```
同样的振幅（0.35 ↔ 1）、同样的 `1.4s infinite`（另外三个 `pulseDeep` 消费者
`RoleplayRoster.module.css:214` / `RoleplayChat.module.css:431` /
`SceneTransition.module.css:272` 用的都是这个时长）。只是相位反了一半，
**在无限循环上视觉不可分辨**。而 `pulseDeep` 的注释自陈就是给「流式指示」用的，
`.stripPulse` 正是流式指示。

### E. `orderFlash` 400ms 超出 UI 预算

```css
/* src/components/settings/panes/ProvidersModels.module.css:318 — 当前 */
.groupFlash { animation: orderFlash 400ms var(--ease-out); }
```
UI 动效预算是 300ms 以内。它是衰减提示而非状态转换，所以只是 LOW；
但全库其余每一个操作后的染色提示都落在 **320ms**
（`LoreReadView.module.css:165` 的 `sectFlash 320ms`），且 320ms 正是
`--transition-slow`。400ms 既超预算又不合屋内节奏，且没有给出理由。

### F. `modalPop` 导出了却零消费者

```ts
/* src/lib/motion.ts:139-143 — 当前 */
export const modalPop: Variants = {
  initial: { opacity: 0, transform: "translateY(8px) scale(0.96)" },
  …
```
`grep -rn "modalPop" src` 只有定义处。全应用 13 个模态一律走 CSS 的
`scaleIn`（`global.css:71`）+ `scaleOut`（`:114`）。**两套并行的模态动效语汇，
只有一套接了线**，而没接线的那套 `scale(0.96)` 恰好与 `scaleIn` 相同——
它读起来像一次没做完的迁移，而不是一个备件。

## Target

- **A**：`motion.ts:30` 改为 `export const EASE_OUT`，`RecentProjects.tsx:34`
  删掉本地 `EASE`、改为从 `lib/motion` 导入并把用到 `EASE` 的三处
  （`:198`、`:305`、`:306` 附近）改用 `EASE_OUT`。
- **B**：`:82`/`:595`/`:604` 的 `ease` → `var(--ease-out)`（**时长保持 140ms**）；
  `:802` 整条 → `transition: opacity var(--transition-fast);`
- **C**：两处 → `var(--transition-fast)`（`RoleplayChat` 那条写成
  `transition: opacity var(--transition-fast), color var(--transition-fast);`）
- **D**：`WriterTurn.module.css` 的 `animation` 改用 `pulseDeep`，
  **删掉** `@keyframes writerPulse` 整块。
- **E**：`400ms` → `320ms`，并在注释里点明「与 sectFlash 同一节奏」。
- **F**：删掉 `motion.ts` 的 `export const modalPop` 整块（含其上方注释里
  专指它的那句，若有）。

## Repo conventions to follow

- 令牌是唯一真相：`tokens.css`。`--transition-fast` = `120ms var(--ease-out)`。
- 复用全局关键帧、不新增；删除受 `src/lib/__tests__/cssKeyframeNames.test.ts` 保护。
- 方案 022 是本方案的体例范本（同一类「漏网之鱼」收敛）。

## Steps

1. `src/lib/motion.ts:30` —— `const EASE_OUT` → `export const EASE_OUT`。
   保留其上方「keep in step with tokens.css」的注释。
2. `src/components/layout/RecentProjects.tsx` —— 删掉 `:34` 的本地 `EASE` 常量
   （连同它那行注释），从 `../../lib/motion` 导入 `EASE_OUT`（**先读一眼该文件
   现有的 import 路径写法再照抄**），把文件内所有 `EASE` 的引用改成 `EASE_OUT`。
   `grep -n "EASE" src/components/layout/RecentProjects.tsx` 应只剩导入与引用。
3. `src/components/settings/panes/DocFormat.module.css` —— `:82`、`:595`、`:604`
   的每个 `140ms ease` → `140ms var(--ease-out)`；`:802` 的
   `transition: opacity 120ms ease;` → `transition: opacity var(--transition-fast);`
4. `src/components/ai/SnippetPicker.module.css:220` 与
   `src/components/roleplay/RoleplayChat.module.css:231` —— 改用 `var(--transition-fast)`。
5. `src/components/ai/WriterTurn.module.css` —— `:390` 的 `writerPulse` → `pulseDeep`，
   删掉 `:393-396` 的 `@keyframes writerPulse` 整块。
6. `src/components/settings/panes/ProvidersModels.module.css:318` —— `400ms` → `320ms`。
7. `src/lib/motion.ts` —— 删掉 `modalPop` 的导出与定义。

## Boundaries

- **不要**把 `140ms` 改成 `120ms`（`--transition-fast`）。本方案只统一**曲线**，
  不重新调三处控件的节奏；那需要单独的目检。
- **不要**删除 `--ease-spring`（`tokens.css:48`）。它确实零消费者，但它是
  design-system.md 明确记载的设计词汇的一部分（"brief pop accents only"），
  一个未被使用的 CSS 令牌零成本，删掉它是**设计决策**而不是清理——若要删，
  单独立案并同步文档。这与删 `modalPop` 不同：后者是一套与既有 CSS 模态语汇
  **竞争**的第二实现，留着会误导。
- **不要**顺手给 `.stripPulse` 改时长或振幅——D 只换关键帧名字。
- **不要**新增任何关键帧或 Motion 预设。
- 若代码与摘录对不上，**停下并报告**。

## Verification

- **机械**：
  - `grep -rn "0.32, 0.72, 0, 1" src` —— 应只剩 **2** 处（`tokens.css:47` 与
    `motion.ts:30`），不再有第三份。
  - `grep -rnE "[0-9]+ms ease[,;]|[0-9]+ms ease$" src --include='*.css'` —— **应为空**。
  - `grep -rn "120ms var(--ease-out)" src --include='*.css' | grep "transition:"` —— **应为空**。
  - `grep -rn "writerPulse\|modalPop" src` —— **应为空**。
  - `grep -n "orderFlash 400ms" src/components/settings/panes/ProvidersModels.module.css` —— 应为空。
  - `pnpm exec tsc --noEmit` 无诊断（第 2、7 步动了 TS，这一步是它们的主要门禁）。
  - `pnpm test` 全绿，**含 `cssKeyframeNames.test.ts`**（第 5 步删了一个关键帧）。
  - `pnpm build` 成功。
  - 产物核对：`grep -ohE "@keyframes [a-zA-Z_]+" dist/assets/*.css | sort -u` 中
    不再有 `writerPulse`；`pulseDeep` 的引用数 **+1**。
- **目检**（`pnpm tauri dev`）：
  - 设置 → 文档格式：开关拨动、行悬停、行内操作淡入——三处观感应与改动前
    **一致**（只换了曲线，140ms 未变）。开关旋钮的位移现在起手更快一点，
    这是本方案期望的改善。
  - `WriterTurn` 的流式脉冲点：应仍在呼吸，节奏与扮演花名册的直播点**一致**
    （现在它们真的是同一个动画了）。
  - 设置 → 供应商与模型，移动一行：底色闪一下应略短于改动前（400→320ms）。
  - 无项目态的最近项目面板：清空 / 撤销的横幅动效应与改动前完全一致
    （第 2 步只换了常量来源，数值没变）。
- **Done when**：上面六条 grep 判据全部成立，三个门禁全绿，且目检无观感回归。
