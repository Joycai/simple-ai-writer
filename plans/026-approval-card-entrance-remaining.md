# 026 — 审批卡入场：补齐 016 漏掉的两个挂载点

- **Status**: DONE (2026-08-26) — `pnpm exec tsc --noEmit` / `pnpm test`(190 文件·2563 用例) / `pnpm build` 全绿，构建产物已核验动画名未作用域化；**作者已在真 Tauri 窗口目检通过**。
- **Commit**: 1a72e2e
- **Severity**: MEDIUM
- **Category**: Cohesion & tokens（一条已定的处方，三个挂载点漏了两个）
- **Estimated scope**: 3 files（1 个 .tsx + 2 个 .module.css），约 20 行

## Problem

`PlanCard` / `ApprovalCard` / `RoundLimitCard` / `TruncationCard` 这四张「运行被阻塞、等你拍板」的卡片有**三个**挂载点：

| 挂载点 | 入场动画 |
|---|---|
| `src/components/ai/AgentChat.tsx:659-671` | ✅ 有 `dropIn` |
| `src/components/ai/AiPanel.tsx:1876-1888` | ❌ 无 |
| `src/components/roleplay/RoleplayChat.tsx:951-955` | ❌ 无 |

只有 AgentChat 做了 —— 那是 **[方案 016](016-approval-card-entrance.md)（DONE）** 的产物，而 016 的 scope 明确写的是「1 个 CSS 文件，1 条新规则」，只覆盖了 `AgentChat.module.css`。同样这四张卡在另外两处的挂载点它没有涉及。本方案是 016 的漏网之鱼，与 015（006 的漏网之鱼）、022（005 的漏网之鱼）同一性质。

016 已把处方和理由定死在注释里，本方案**逐字沿用**，不重新论证：

```css
/* src/components/ai/AgentChat.module.css:295-310 — 现状（正确的样板） */
.approvals {
  padding: 0 var(--space-6) var(--space-3) calc(var(--space-6) + 8px + var(--space-3));
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 卡片从上方的助手轮次「落下来」——方向与上面那条注释里的空间说法一致
   （缩进在助手内容轨上，读作从上一轮长出来）。挂在子元素上而不是容器上：
   容器在已有卡片的情况下追加第二张时不会重挂载，动画就不会播。
   流式记录行仍然刻意零入场动画（见 plans/003）——审批卡是相反的东西：
   一次运行里出现个位数次，到达即意味着流停了、必须等一次人工输入。 */
.approvals > * {
  animation: dropIn 200ms var(--ease-out);
  transform-origin: top left;
}
```

另外两处，同样这几张卡瞬间出现，零过渡：

```tsx
// src/components/ai/AiPanel.tsx:1874-1888 — 现状（裸渲染在 .resultScroll 的 flow 里，无包裹层）
          {/* Pending lore plans + manuscript edits + round-cap questions — the
              loop is blocked on these */}
          {pendingPlans.map((p) => (
            <PlanCard key={p.plan.id} item={p} />
          ))}
          {pendingApprovals.map((p) => (
            <ApprovalCard key={p.proposal.id} item={p} />
          ))}
          {pendingTruncations.map((p) => (
            <TruncationCard key={p.id} item={p} />
          ))}
          {pendingRoundLimits.map((p) => (
            <RoundLimitCard key={p.id} item={p} />
          ))}
```

```css
/* src/components/roleplay/RoleplayChat.module.css:659-670 — 现状（有容器，无子元素动画） */
.approvals {
  flex-shrink: 0;
  width: 640px;
  max-width: calc(100% - 52px);
  margin: 0 auto;
  padding-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 46vh;
  overflow-y: auto;
}
```

**为什么重要**：这是全 app 信息量最大的一个瞬间——模型停下来了，流不再动了，必须等一次人工输入。在 AgentChat 里它「落下来」所以看得见；在另外两个界面里它无声地出现在一段静止的界面中间，作者可能盯着一个已经停住的面板等下一个 token。

## Target

三处行为一致：卡片以 `dropIn` 落下，200ms，`--ease-out`，`transform-origin: top left`。

```css
/* target — src/components/ai/AiPanel.module.css，新增 */
.approvals {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.approvals > * {
  animation: dropIn 200ms var(--ease-out);
  transform-origin: top left;
}
```

```css
/* target — src/components/roleplay/RoleplayChat.module.css，在现有 .approvals 之后新增 */
.approvals > * {
  animation: dropIn 200ms var(--ease-out);
  transform-origin: top left;
}
```

```tsx
// target — src/components/ai/AiPanel.tsx，四个 map 包进一个带守卫的容器
          {(pendingPlans.length > 0 || pendingApprovals.length > 0
            || pendingTruncations.length > 0 || pendingRoundLimits.length > 0) && (
            <div className={styles.approvals}>
              {pendingPlans.map((p) => (
                <PlanCard key={p.plan.id} item={p} />
              ))}
              {pendingApprovals.map((p) => (
                <ApprovalCard key={p.proposal.id} item={p} />
              ))}
              {pendingTruncations.map((p) => (
                <TruncationCard key={p.id} item={p} />
              ))}
              {pendingRoundLimits.map((p) => (
                <RoundLimitCard key={p.id} item={p} />
              ))}
            </div>
          )}
```

## Repo conventions to follow

- `dropIn` 是 `src/styles/global.css:86-89` 里已有的全局关键帧，**不要重新定义**：
  ```css
  @keyframes dropIn {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to   { opacity: 1; transform: none; }
  }
  ```
- 缓动 token 在 `src/styles/tokens.css:47`：`--ease-out: cubic-bezier(0.32, 0.72, 0, 1)`。**只用 token 名，不要内联 cubic-bezier。**
- 间距 token：`--space-2: 8px`（`src/styles/tokens.css`）。
- **样板文件**：`src/components/ai/AgentChat.module.css:295-310`。照抄它的选择器形状（`.approvals > *` 而非 `.approvals`）和它的注释精神。
- 动画**必须挂在 `> *` 上，不能挂在容器上**：容器在已有卡片的情况下追加第二张时不会重挂载，挂容器上动画就不会播。这是 016 定案时写明的原因（见该方案 Target 一节「`> *` 而不是 `.approvals` 自身」），不要「简化」掉。
- 四种卡片的根元素都已确认是单个 `<div className={styles.card}>`（016 已核对：`ApprovalCard.tsx`、`PlanCard.tsx:40`、`RoundLimitCard.tsx:20`、`TruncationCard.tsx:22`），所以 `> *` 精确命中一张卡一个元素。
- **模块 CSS 引用 global.css 的 keyframes 是可行的**：这条曾经静默失效（`docs/issues/css-modules-global-keyframes.md`），已于 2026-08-23 随 `vite.config.ts` 切 LightningCSS 修复，016 于 2026-08-26 核对构建产物确认动画真的在播。不要因为担心作用域而把 `dropIn` 复制进模块 —— 那会违反方案 019 要守的全局唯一性不变量。
- 全局 `prefers-reduced-motion`（`src/styles/global.css:122-129`）已经把所有 `animation-duration` 压到 `0.001ms !important`。**不要**为本次改动新增任何 reduced-motion 媒体查询——该策略是全局统一的，设计规范明确写了「handled globally — don't fight it」。

## Steps

1. **`src/components/ai/AiPanel.module.css`** — 在 `.resultSection`（第 608 行）之前新增：
   ```css
   /* 阻塞中的卡片成组：彼此 8px，与上下的结果小节仍保持 .resultScroll 的 20px。
      动画挂在子元素上而不是容器上——容器在已有卡片的情况下追加第二张时不会
      重挂载，挂容器上动画就不会播（同 AgentChat.module.css:307）。 */
   .approvals {
     display: flex;
     flex-direction: column;
     gap: var(--space-2);
   }
   .approvals > * {
     animation: dropIn 200ms var(--ease-out);
     transform-origin: top left;
   }
   ```

2. **`src/components/ai/AiPanel.tsx:1874-1888`** — 把四个 `.map()` 包进 `<div className={styles.approvals}>`，并加上守卫条件（见上面 Target 的 tsx 块，逐字采用）。
   **守卫不能省**：`.resultScroll` 有 `gap: var(--space-5)`（20px），一个空的 flex 子元素高度为 0 但两侧的 gap 照样生效，会凭空多出 20px 的洞。

3. **`src/components/roleplay/RoleplayChat.module.css`** — 在现有 `.approvals` 规则块（第 659-670 行）**之后**新增：
   ```css
   /* 卡片落下来。挂在子元素上而不是容器上——容器在已有卡片的情况下追加第二张
      时不会重挂载，挂容器上动画就不会播（同 AgentChat.module.css:307）。 */
   .approvals > * {
     animation: dropIn 200ms var(--ease-out);
     transform-origin: top left;
   }
   ```
   不要修改现有 `.approvals` 的任何一行。

## Boundaries

- 不要碰 `src/components/ai/AgentChat.module.css` 或 `AgentChat.tsx` —— 那里已经是对的，是本次的样板。
- 不要碰 `ApprovalCard.module.css` / `PlanCard.module.css` / `RoundLimitCard.module.css`。在卡片自身的 `.card` 上加动画会与 AgentChat 的 `.approvals > *` 同特异度（都是 0,1,0）冲突，胜负取决于模块打包顺序 —— 这正是要避免的。
- 不要改这四个卡片组件的 props、markup 或 key。
- 不要新增依赖，不要引入 `motion`（`lib/motion.ts` 只用于需要**退场**动画的浮层；这里是纯入场，CSS 关键帧即可 —— 见 `docs/reference/design-system.md:242-251`）。
- 不要新增 `@keyframes`，`dropIn` 已存在。
- 若代码与上面的摘录对不上（自 1a72e2e 起有漂移），**停下来报告**，不要即兴发挥。

## Verification

- **Mechanical**：
  - `pnpm tsc --noEmit` —— 无报错。
  - `pnpm test` —— 全绿（本次改动不应影响任何测试）。
- **Feel check**：`pnpm tauri dev`，然后
  - **AiPanel**：打开 AI 面板，跑一个会产生 L2 写入提案的 agent 任务（例如让它改写当前文档的一段）。确认审批卡从上方 4px 处落下并轻微放大到位，约 200ms，**不是**瞬间出现。
  - **追加第二张**：在第一张卡还在等待时让运行再产生一张卡（或用两个待批提案）。确认**新那张**播动画，**已在场的那张不重播**。这是「挂 `> *` 而非容器」唯一能验出来的地方。
  - **RoleplayChat**：开启角色扮演 Beta 开关，让旁白提出一次改稿，确认卡片同样落下。注意 `.approvals` 有 `overflow-y: auto` + `max-height: 46vh` —— 确认 `translateY(-4px)` 期间**没有**闪出一条竖直滚动条。
  - **无卡片时**：AiPanel 在没有任何待批卡片时，「注入」小节与「运行」小节之间的间距应与改动前**完全一致**（这验证了第 2 步的守卫）。
  - DevTools → Animations 面板，播放速度调到 10%，确认卡片是**向下**落入（从 `translateY(-4px)` 到 0），不是向上升。
  - DevTools → Rendering → 勾选 `prefers-reduced-motion: reduce`，确认卡片瞬间出现、无位移（全局规则接管），且**没有**残留在半透明状态。
- **Done when**：三个挂载点的审批卡入场表现一致；追加卡片时旧卡不重播；AiPanel 无待批卡片时布局无变化。
