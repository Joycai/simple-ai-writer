# 027 — 一致性检查结果统一淡入落位，取代硬切

- **Status**: DONE (2026-08-26) — `pnpm exec tsc --noEmit` / `pnpm test`(190 文件·2563 用例) / `pnpm build` 全绿，构建产物已核验动画名未作用域化；**作者已在真 Tauri 窗口目检通过**。
- **Commit**: 1a72e2e
- **Severity**: MEDIUM
- **Category**: 遗漏机会（防止突兀跳变）
- **Estimated scope**: 1 个 CSS 文件，1 条新规则（3 行）。**无 TSX 改动。**

> **本方案不做错峰（stagger）。** 起草时曾拟按 `nth-child` 发 `animation-delay`
> 做逐条错峰，**已在立案阶段自我否决**——理由与实测见下方「为什么不做错峰」，
> 它与方案 025 第 2 步的撤回是同一个失败模式。**不要把错峰加回来。**

## Problem

一致性检查是一次跨越数秒的扫描：面板先显示 `.scanning` 的转圈与流式进度，扫描结束后，N 张发现卡**同时**硬切出现，零过渡。

```tsx
// src/components/ai/ConsistencyCheck.tsx:225-240 — 现状
        ) : (
          <div className={styles.issueList}>
            {visible.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                docText={content}
                actionable={onTarget}
                categoryLabel={label(issue.category)}
                onLocate={() => locate(issue.id)}
                onApply={() => apply(issue.id)}
                onIgnore={() => ignore(issue.id)}
                onOpenEntity={issue.entityDirPath ? () => goToEntity(issue.entityDirPath!) : undefined}
              />
            ))}
          </div>
        )}
```

```css
/* src/components/ai/ConsistencyCheck.module.css:64-77 — 现状：容器与卡片都无入场动画 */
.issueList {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.issue {
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-panel);
  /* Severity bars are semantic marks, a documented exception to the
     no-colored-left-border rule (docs/reference/design-system.md). */
  border-left: 3px solid var(--color-border-emphasis);
  padding: 12px 16px;
}
```

`IssueCard` 的根节点是单个 `<div className={styles.issue} …>`（`ConsistencyCheck.tsx:318`），是 `.issueList` 的直接子元素 —— 所以 `.issueList > *` 精确命中一张卡一个元素，不需要改组件。

**为什么重要**：作者盯着转圈等了几秒，然后一整屏卡片凭空砸下来。等待越久，硬切越突兀。

## 为什么不做错峰（起草时的候选方案，已否决）

拟案是 `.issueList > *:nth-child(n)` 逐级发 40ms 的 `animation-delay`。**它会坏在列表的主操作上：**

`ignore(id)` 把该条加进 `resolved`（`consistencyStore.ts:189`），而列表来自
`openIssues(report, resolved)`，其实现是 `report?.issues.filter((i) => !resolved.has(i.id))`
（`consistencyStore.ts:65`）。也就是说**作者每忽略一条发现，该条就从列表里移除**，
其后每一张卡片的 `nth-child` 位次都前移一位 → `animation-delay` 取值改变 →
浏览器把这些**并未重挂载**的卡片的动画整体重启。

结果：忽略第 2 条，第 3–10 条会集体重新错峰入场一次。这不是入场，是列表在作者
手底下抖了一下。

这与 **方案 025 第 2 步（知识库墙卡片错峰）的撤回是同一个失败模式**——那次的触发
器是搜索打字导致单张卡挂载，实测记录在 `025-wall-scope-switch-softening.md:15-38`，
结论是：要让错峰成立就得引入一个「本次是不是换幕」的时序状态位，而
**收益配不上这份复杂度**。此处触发器换成了「忽略一条发现」，代价结论不变，而且
比 025 更糟——025 的触发器是搜索，此处是这个列表最主要的操作之一。

**统一淡入没有这个问题**：`animation` 属性在所有子元素上取值相同、且不随位次变化，
移除一张卡不会改变任何幸存卡片的动画属性，因此不会重启。只有**真正新挂载**的元素
才会播一次，这正是想要的语义。

## Target

```css
/* target — src/components/ai/ConsistencyCheck.module.css，在 .issueList 之后新增 */
.issueList > * {
  animation: slideUp 200ms var(--ease-out);
}
```

三个取值的理由：

- **`slideUp` 而不是 `fadeIn`**：结果是从上方的 `.scanning` 区域「接替」过来的，
  6px 的上推让这一列读作落位而不是替换。`slideUp` 是 `global.css:59-62` 的既有关键帧。
- **200ms（`--transition-base` 的刻度）**：与方案 016 的审批卡同档——都是要求作者
  停下来读的结果面，不是瞬开瞬关的浮层。仍在 UI 300ms 预算内。
- **不带 `both` / 不带 delay**：没有 delay 就不需要 `both` 来压住延迟期间的可见性；
  少一个填充模式，就少一处「忽略一条卡后幸存卡片停在最终态还是初始态」的推理负担。

## Repo conventions to follow

- `slideUp` 是 `src/styles/global.css:59-62` 里已有的全局关键帧，**不要重新定义**：
  ```css
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  ```
- 缓动 token：`src/styles/tokens.css:47` 的 `--ease-out: cubic-bezier(0.32, 0.72, 0, 1)`。只用 token 名，不内联 cubic-bezier（方案 022 刚清理过两处手写复刻）。
- **样板文件**：`src/components/ai/AgentChat.module.css:307` 的 `.approvals > *`（方案 016 落地）—— 同样是「动画挂在列表的直接子元素上，容器不动」的写法。照抄这个形状。
- **模块 CSS 引用 global.css 的 keyframes 是可行的**：这条曾经静默失效（`docs/issues/css-modules-global-keyframes.md`），已于 2026-08-23 随 `vite.config.ts` 切 LightningCSS 修复并复核生效（见 `plans/README.md` 的「阻断 A」）。**不要**因为担心作用域而把 `slideUp` 复制进本模块 —— 模块内的 `@keyframes` 现在与 global.css 共用一个全局命名空间，重名会静默覆盖，`src/lib/__tests__/cssKeyframeNames.test.ts`（方案 019）会因此报错。
- 全局 `prefers-reduced-motion`（`src/styles/global.css:122-129`）已把 `animation-duration` 压到 `0.001ms !important`。本方案**不带 delay**，所以全局规则足够，**不要**新增任何 reduced-motion 媒体查询——设计规范写明「handled globally — don't fight it」。

## Steps

1. **`src/components/ai/ConsistencyCheck.module.css`** — 在 `.issueList` 规则块（第 64-68 行）**之后**、`.issue` 规则块（第 70 行）**之前**插入：
   ```css
   /* 扫描要跑好几秒，结果一次性砸下来太硬。逐张按自己的 mount 落位一次。
      挂在直接子元素上（同 AgentChat.module.css:307，方案 016），IssueCard 因此
      不必接 className 或 style。
      **刻意不做错峰**：忽略一条发现会把它从 openIssues 里移除，其后每张卡的
      nth-child 位次前移，任何基于位次的 animation-delay 都会让并未重挂载的卡片
      集体重放——同方案 025 第 2 步的撤回理由。统一取值不随位次变化，无此问题。 */
   .issueList > * {
     animation: slideUp 200ms var(--ease-out);
   }
   ```

就这一步。

## Boundaries

- **不要加 `animation-delay`、`nth-child`、`staggerChildren` 或任何形式的错峰**，理由见上。若你认为错峰更好看，**停下来报告**，不要自行实现。
- **不要修改 `src/components/ai/ConsistencyCheck.tsx`** —— 本方案零 TSX 改动。若你觉得需要改组件才能实现，说明走错路了，停下来报告。
- 不要修改 `.issue` / `.issueConflict` / `.issueWarning` / `.issuePass` 的任何现有声明。
- 不要给 `.emptyState`（`ConsistencyCheck.tsx:217`）或 `.scanning`（第 182 行）加动画 —— 本次只做发现列表。
- 不要碰 `.passSummary` / `.passItems` 那个「已通过」折叠区（第 245-265 行）。
- 不要新增 `@keyframes`，`slideUp` 已存在。不要新增依赖，不要引入 `motion`。
- 若代码与上面的摘录对不上（自 1a72e2e 起有漂移），**停下来报告**。

## Verification

- **Mechanical**：
  - `pnpm tsc --noEmit` —— 无报错。
  - `pnpm test` —— 全绿，**特别是 `src/lib/__tests__/cssKeyframeNames.test.ts`**（方案 019 的关键帧唯一性守卫；本方案不新增关键帧，它应当照常通过）。
  - `git diff --stat` 应只显示 `src/components/ai/ConsistencyCheck.module.css` 一个文件。
- **Feel check**：`pnpm tauri dev`，打开一个有知识库条目的项目，对一份正文跑一致性检查。
  - 确认发现卡**淡入并轻微上推**落位，约 0.2s，而不是硬切出现。
  - **关键回归（本方案存在的理由）**：在一份有 5 条以上发现的报告里，点击第 2 条的「忽略」。确认**其余卡片只是向上补位，没有任何一张重新淡入或位移**。若看到幸存卡片重放动画，说明有人加回了基于位次的 delay —— 停下来报告。
  - **筛选页签**：切换顶部分类页签。仍在列表里的卡片**不应**重放（它们 `key={issue.id}` 未变、未重挂载）；新纳入的卡片播一次入场，这是预期。
  - **应用建议**：点一条发现的「应用」，确认它消失后其余卡片同样只是补位、不重放。
  - DevTools → Animations 面板，播放速度 10%，确认卡片是**向上**推入（从 `translateY(6px)` 到 0），且同一批卡片**同时**开始、同时结束（无阶梯 —— 这正是本方案要的）。
  - DevTools → Rendering → 勾选 `prefers-reduced-motion: reduce`，确认卡片瞬间出现且完全不透明、无残留位移。
- **Done when**：结果列表淡入落位；忽略/应用任一条后幸存卡片不重放；筛选切换时留存卡片不重放；未改动任何 .tsx 文件；关键帧守卫测试通过。
