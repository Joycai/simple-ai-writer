# 016 — 审批卡入场：循环停在这里等作者点头

- **Status**: DONE (2026-08-23 落地；2026-08-26 复核生效)。曾因「阻断 A · keyframe 作用域」不生效，该阻断已随 `vite.config.ts` 切 LightningCSS 解决——2026-08-26 核对构建产物确认本方案的动画引用已命中定义、真的在播。本方案无需再改
- **Commit**: 78160c2
- **Severity**: MEDIUM
- **Category**: 遗漏机会（防止突兀跳变）
- **Estimated scope**: 1 个 CSS 文件，1 条新规则（3 行）

## Problem

agent 循环被阻塞时，四种卡片会落在合成框上方的审批区里：`PlanCard`（设定写入方案）、`ApprovalCard`（L2 手稿写入）、`RoundLimitCard`（轮次上限追问）、`TruncationCard`。它们**一帧硬切出现**，而出现的位置正是刚才还在滚动的流式记录下缘：

```tsx
// src/components/ai/AgentChat.tsx:472-491 — 现状
      {(pendingPlans.length > 0 || pending.length > 0 || pendingRoundLimits.length > 0
        || pendingTruncations.length > 0) && (
        <div className={styles.approvals}>
          {pendingPlans.map((p) => (
            <PlanCard key={p.plan.id} item={p} />
          ))}
          {pending.map((p) => (
            <ApprovalCard key={p.proposal.id} item={p} />
          ))}
```

```css
/* src/components/ai/AgentChat.module.css:202-210 — 现状 */
/* Docked above the composer (the loop is blocked on these, so they must stay put
   while the transcript scrolls) but indented onto the assistant content track,
   so a proposal still reads as coming from the turn above it. */
.approvals {
  padding: 0 var(--space-6) var(--space-3) calc(var(--space-6) + 8px + var(--space-3));
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
```

这是全应用最需要被看见的一刻：循环**停住了**，在等作者决定要不要让模型改稿。而它出现得比一行流式文本还安静。

**为什么这不违反「AgentChat 流式行刻意不做入场动画」那条约定**（方案 003 的 Repo conventions 一节引用过它）：那条约定针对的是**流式记录行**——它们在一次运行里连续、快速地成批到达，逐行动画会变成频闪。审批卡是相反的东西：一次运行里出现个位数次，到达即意味着**流停了**，且必须停在原地等一次人工输入。两者频率与语义都不同档。本方案**只动 `.approvals` 的直接子元素，不碰记录流里的任何一行**。

## Target

```css
/* src/components/ai/AgentChat.module.css — 目标：在 .approvals 规则之后新增 */
/* 卡片从上方的助手轮次「落下来」——方向与上面那条注释里的空间说法一致
   （缩进在助手内容轨上，读作从上一轮长出来）。挂在子元素上而不是容器上：
   容器在已有卡片的情况下追加第二张时不会重挂载，动画就不会播。 */
.approvals > * {
  animation: dropIn 200ms var(--ease-out);
  transform-origin: top left;
}
```

三个取值的理由，逐条：

- **`dropIn` 而不是 `riseIn`**：由 `.approvals` 自己的注释定案——「indented onto the assistant content track, so a proposal still reads as coming from the turn above it」。既然产品意图是「它来自上面那一轮」，就必须从上方落下（`translateY(-4px) → 0`）。用 `riseIn` 会让它读作从合成框里冒出来，与既有说法相反。
- **`> *` 而不是 `.approvals` 自身**：包裹层是条件渲染，但只在「一张卡都没有 → 有卡」时挂载。第一张卡还在等审批、第二张追加进来时，包裹层不重挂载，挂在它身上的动画不会播——新卡照样硬切。挂在子元素上则每张卡各自按自己的 mount 播一次。四种卡片的根元素都确认是单个 `<div className={styles.card}>`（`ApprovalCard.tsx:410` 导出组件、`PlanCard.tsx:40`、`RoundLimitCard.tsx:20`、`TruncationCard.tsx:22`），所以 `> *` 精确命中一张卡一个元素。
- **200ms（`--transition-base` 的刻度）而不是弹出层的 140/160ms**：这不是一个瞬开瞬关的浮层，是一个要求作者停下来读的决策面。200ms 仍在 UI 300ms 预算内。

`transform-origin: top left` 让 2% 缩放锚在助手内容轨的缩进边上，与卡片实际「挂靠」的那条线一致。

## Repo conventions to follow

- `dropIn` 是 `global.css:86-89` 的共享帧，方案 006 引入。模块引用本文件未声明的动画名会透传到全局（先例：`AiDrawer.module.css:115`）。**不要**本地重声明。
- 同一文件里已有的写法可直接对照：`AgentChat.module.css:189` 的 `animation: spin 0.8s linear infinite;` 同样引用全局帧。
- reduced-motion 走 `global.css:122` 的全局兜底，**不要**加本地 `@media (prefers-reduced-motion)` 反压——审批卡不承担「还活着」的信号（那是 `AgentChat.module.css:550` 给 `.thinkingSpinner` 开的例外）。卡片本身会一直停在屏幕上等作者，归零不会让人误判。

## Steps

1. `src/components/ai/AgentChat.module.css`：在 `.approvals` 规则**结束的右花括号之后**、`/* Band ④ …… */` 注释之前，插入 Target 一节给出的注释与 `.approvals > *` 规则整块。
   - 不要修改 `.approvals` 规则自身的任何一行。
   - 不要动它上方那段既有注释。

## Boundaries

- 只新增一条 `.approvals > *` 规则。不修改 `.approvals`、`.taskBand`、`.error` 或本文件任何其他规则。
- **不动 `AgentChat.tsx`**——不加 key、不加 Motion、不改条件渲染结构。
- 不动 `ApprovalCard` / `PlanCard` / `RoundLimitCard` / `TruncationCard` 四个组件的 TSX 或它们各自的 `.module.css`。
- 不给流式记录行（`.userTurn` / `.assistantTurn` / `.turnContent`）添加任何动画——那是被刻意保留的空白，见上文 Problem。
- 不在本模块声明 `@keyframes`，不动 `global.css`。
- 不引入 Motion。
- 若 `.approvals` 规则或四个卡片的根元素与上文摘录不符（相对 78160c2 有漂移），停下报告。

## Verification

- **Mechanical**:
  - `pnpm tsc --noEmit` 通过。
  - `pnpm build` 通过。
  - `grep -n "@keyframes" src/components/ai/AgentChat.module.css` 应只命中既有的 `shimmer`（第 543 行附近）与文件内原有帧，**不得**出现新增的 `dropIn`。
- **Feel check**: `pnpm dev`，开一个项目，在 AI 抽屉的聊天模式里让 agent 执行一次会写文件的任务（例如请它改写当前文档的一段）：
  - 审批卡出现时应从**上方 4px 处落下并淡入**，能明确感到「流停了、这里有事要办」，而不是凭空多出一块。
  - **关键回归**：让 agent 在一次运行里连续提出两个写入。第一张卡还挂着时第二张到达，**第二张也必须播动画**（这正是把规则挂在 `> *` 而不是容器上的原因）。若第二张硬切出现，说明选择器写错了。
  - **关键回归**：审批卡挂在屏幕上期间，让流式文本继续滚动 / 触发一次组件重渲（例如切换自动批准开关）。卡片**不得**重播动画——CSS animation 只在 mount 时触发，重渲不该重放。若看到闪烁，说明有地方在改 key。
  - DevTools → Animations，播放速度 10%：确认位移只有 4px、缩放只有 2%，原点在卡片左上角。
  - DevTools → Rendering → `prefers-reduced-motion: reduce`：卡片瞬时出现（全局兜底的预期行为）。卡片仍停在原地等待，信息没有丢失。
- **Done when**: 每一张新到达的审批卡（含同一运行内的第二张、第三张）都从上方落入；记录流的滚动与重渲不触发任何重播；流式行仍然零动画。
