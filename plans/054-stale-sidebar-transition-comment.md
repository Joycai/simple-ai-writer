# 054 — App.tsx 里一段注释仍在描述方案 031 删掉的 320ms 折叠过渡

- **Status**: DONE（门禁已过；无运行时变化）
- **Commit**: 485de63
- **Severity**: LOW
- **Category**: 7 统一性与令牌（文档/注释一致性）
- **Estimated scope**: 1 个 TSX 文件，3 行注释

> **这是方案 031 的遗留**，不是新发现的动效问题。031 的 Boundaries 明文写着「**不要**改 `src/App.tsx`」
> （它只想动折叠的表现、不碰触发逻辑），于是这段描述该行为的注释没有跟着更新。

## Problem

方案 031（HIGH，已 DONE，commit `43b52e9`）删掉了侧栏的 `transition: width var(--transition-slow), border-right-width var(--transition-slow)`，
理由是：`width` 是布局属性，折叠一次会让编辑器整列在 320ms 里回流约 19 次；且触发器是 IconRail 上再点一次已激活的标签，
属 AUDIT §1「永不动画」那一档。`Sidebar.module.css:11-17` 现在有一整段注释解释这个**故意**的缺席。

但拖拽收尾处的注释还停在改动之前：

```tsx
// src/App.tsx:74-77 — 当前
  const onResizeEnd = () => {
    // The last move's frame may not have run yet, and the next line puts the
    // 320ms collapse transition back — leaving the gap unwritten would let the
    // sidebar drift on for a third of a second after the button came up.
    if (rafId.current !== null) {
```

「the next line puts the 320ms collapse transition back」描述的是 `removeAttribute("data-resizing")` 之后
`.sidebar` 会恢复一条 320ms 过渡——**那条过渡已经不存在了**。

为什么值得改而不是放着：这段注释在**劝说下一个读者相信侧栏有折叠过渡**。
它紧挨着 `removeAttribute("data-resizing")`，读起来像是在解释那条 `:global([data-resizing]) .sidebar { transition: none; }`
（`Sidebar.module.css:25-27`，方案 031 明文决定**保留**，即便它在删掉 `.sidebar` 的 transition 后已是空操作）。
两者叠在一起，很容易让人「顺手把过渡补回去」——那正是方案 031 花了一整份 HIGH 方案删掉的东西。

**取消 rAF 那几行代码本身是对的**，不要动：最后一次 `onResizeDelta` 排的帧可能还没跑，
不取消并立即 `flushWidth()` 的话，那一帧会在释放之后再写一次已经过时的宽度。理由成立，只是注释把它挂错了因。

## Target

```tsx
// target — src/App.tsx:74-77
  const onResizeEnd = () => {
    // 最后一次 move 排的那一帧可能还没跑。不取消就直接走下去的话，它会在释放
    // 之后再写一次已经过时的 --sidebar-width，把宽度弹回上一个采样点。所以这里
    // 先取消、再同步 flush 一次，让释放那一刻的值就是最终值。
    // （注：侧栏折叠**没有**过渡——方案 031 删掉了那条 320ms，理由见
    //  Sidebar.module.css 的 .sidebar 注释。别照着旧注释把它补回来。）
    if (rafId.current !== null) {
```

## Repo conventions to follow

- 本仓的注释体例：**解释「为什么」，并在删掉某个东西的原位留一句「别补回来」**。
  范本就是方案 031 自己留在 `src/components/layout/Sidebar.module.css:11-17` 的那段——
  它把布局回流的量级（「320ms 约 19 次全文档列回流」）和频次裁决都写在了原位。
- 中英混排在本仓是常态（`App.tsx` 附近两段拖拽注释是英文，`Sidebar.module.css` 是中文）。
  本方案改的这段跟随**它所指向的那份解释**（`Sidebar.module.css`，中文），用中文。
- 引用方案编号的写法照 `Sidebar.module.css` / `AgentChat.module.css` 既有的「方案 NNN」。

## Steps

1. `src/App.tsx` —— 把 `:75-77` 这三行注释替换为 Target 里的五行注释。`const onResizeEnd = () => {`（`:74`）与其后的所有**代码**一行不动。

## Boundaries

- **不要**改 `onResizeEnd` 的任何一行代码（`cancelAnimationFrame` / `flushWidth()` / `removeAttribute` / `setSidebarWidth` 的顺序全部正确，方案 021 定的）。
- **不要**改 `src/components/layout/Sidebar.module.css`。尤其**不要**删 `:global([data-resizing]) .sidebar { transition: none; }` ——
  方案 031「Repo conventions to follow」第三条明确决定保留它（「删掉 `.sidebar` 的 `transition` 之后它确实变成空操作，
  但它表达的是另一条不变量……方案 001 的 Verification 还在引用它。**留着。**」）。这是既定决策，不在本方案范围。
- **不要**顺手给侧栏折叠加回任何过渡。
- **不要**改 `App.tsx` 里其它任何注释或代码。
- 若摘录与代码对不上（自 `485de63` 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -n "320ms collapse transition" src/App.tsx` → **空**。
  - `grep -rn "transition" src/components/layout/Sidebar.module.css` → 仍应有 `:global([data-resizing])` 那条 `transition: none`，且**没有** `width` / `border-right-width`（方案 031 的状态不变）。
  - `node_modules/.bin/tsc --noEmit` 无诊断（直跑二进制，绕开 pnpm 的安装摘要）；`pnpm test` 全绿；`pnpm build` 成功。
- **Feel check**：本方案**不改变任何运行时行为**，所以判据是「什么都没变」：
  - `pnpm dev` 浏览器即可：拖动侧栏右边缘，跟手、无拖尾、松手后宽度不回弹（方案 021 的既有行为）。
  - 在 IconRail 上再点一次已激活的标签折叠侧栏：**立即**折叠，没有 320ms 推挤（方案 031 的既有行为）。
- **Done when**：`grep` 查不到那句过期描述，拖拽与折叠行为与改动前逐一相同，三项门禁通过。
