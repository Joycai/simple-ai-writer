# 036 — AgentLog 进度条改用 transform: scaleX（三方独立确认）

- **Status**: DONE（门禁已过，目检待作者）
- **Commit**: 43b52e9
- **Severity**: MEDIUM
- **Category**: 5 性能
- **Estimated scope**: 1 个 CSS 文件 + 1 个 TSX 文件，各数行

> 这条由三条互不知情的路径独立命中：一次 `/code-review`（提交 5ee043a5）、
> 本轮性能审计、以及审计 recon 的必查清单。处方一致。

## Problem

`src/components/ai/AgentLog.module.css:173-178` —— 当前代码：

```css
.rowProgressFill {
  display: block;
  height: 100%;
  background: var(--color-sienna);
  transition: width var(--transition-base);
}
```

由内联样式驱动：

```tsx
/* src/components/ai/AgentLog.tsx:345-351 — 当前 */
      {progress?.ratio !== undefined && (
        <span className={styles.rowProgress} aria-hidden="true">
          <span
            className={styles.rowProgressFill}
            style={{ width: `${Math.round(Math.min(1, Math.max(0, progress.ratio)) * 100)}%` }}
          />
        </span>
      )}
```

两个问题：

1. **`width` 是布局属性**（layout + paint + composite）。`ratio` 每完成一个工作
   单位就发一次（`src/lib/translate/tool.ts:151`、`src/lib/agent/tools.ts:901`），
   一次整章翻译会连续重触发几十次 200ms 的 width 过渡；而同一时刻 agent 日志
   本身正随流式分片重渲染。仓库自己的进度条约定**恰恰相反**：

   ```css
   /* src/components/ai/AiPanel.module.css:411-418 — 已有，正确 */
   .progressFill {
     display: block;
     width: 100%;
     height: 100%;
     background: var(--color-success-bar);
     transform-origin: left;
     transition: transform var(--transition-base);
   }
   ```

2. **过渡时长比数据到达间隔还长**。`--transition-base` 是 200ms，而进度上报节流是
   `PROGRESS_EVERY_MS = 150`（`src/lib/agent/tools.ts:860`）——条永远在追一个
   已经过期的目标，**永远追不上真实值**。

## Target

```css
/* target — src/components/ai/AgentLog.module.css */
.rowProgressFill {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--color-sienna);
  /* scaleX 而不是 width：width 是布局属性，而这条线在长工具调用里每 ~150ms
     就换一次值（PROGRESS_EVERY_MS，lib/agent/tools.ts:860），同一时刻日志本身
     还在随流式分片重渲染。transform 走合成层。范本：AiPanel.module.css:411。
     时长用 --transition-fast 而非 --base：200ms 比数据到达间隔（150ms）还长，
     条会永远追一个已过期的目标。 */
  transform-origin: left;
  transition: transform var(--transition-fast);
}
```

```tsx
/* target — src/components/ai/AgentLog.tsx:345-351 */
      {progress?.ratio !== undefined && (
        <span className={styles.rowProgress} aria-hidden="true">
          <span
            className={styles.rowProgressFill}
            style={{ transform: `scaleX(${Math.min(1, Math.max(0, progress.ratio))})` }}
          />
        </span>
      )}
    )}
```

注意 `scaleX` 取的是 **0–1 的比值本身**，不再 `* 100`、不再 `Math.round`
（四舍五入到整百分比是 width 写法遗留的量化，transform 不需要）。

## Repo conventions to follow

- 进度条一律 `width: 100%` + `transform-origin: left` + `transition: transform`。
  范本逐字在 `src/components/ai/AiPanel.module.css:409-418`。
- 时长走令牌：`--transition-fast` = `120ms var(--ease-out)`（`tokens.css:52`）。
- 轨道 `.rowProgress`（`:164-172`）是 `position: absolute` 的定宽轨，
  已经限定了范围，**不要改它**。

## Steps

1. `src/components/ai/AgentLog.module.css` —— 按 Target 改写 `.rowProgressFill`：
   新增 `width: 100%` 与 `transform-origin: left`，把
   `transition: width var(--transition-base)` 换成
   `transition: transform var(--transition-fast)`，并写入 Target 里的注释。
2. `src/components/ai/AgentLog.tsx` —— 把内联的 `style={{ width: … }}` 换成
   `style={{ transform: \`scaleX(${…})\` }}`，去掉 `* 100` 与 `Math.round`，
   保留 `Math.min(1, Math.max(0, progress.ratio))` 的钳位。
3. 不要动 `.bare .rowProgress`（`:173`）那条覆盖。

## Boundaries

- **不要**改 `PROGRESS_EVERY_MS`、`src/lib/agent/tools.ts` 或
  `src/lib/translate/tool.ts` —— 进度**产生**侧不在本方案范围内。
  （`/code-review` 对 `runtime.ts:1125` 的 `bumpContext` 另有一条更重的发现，
  那是独立问题，不要顺手一起改。）
- **不要**给 `.rowProgress` 轨道加 `overflow: hidden` 之类的「保险」——
  `scaleX` 在 `transform-origin: left` 下不会溢出轨道右缘。
- **不要**改进度标签的文案或排序（`AgentLog.tsx` 的 `rowMetaRight` / `useHeadline`）。
- 若代码与摘录对不上（自 43b52e9 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -n "transition: width" src/components/ai/AgentLog.module.css` —— 应为空。
  - `grep -rn "transition:.*width" src --include='*.module.css'` —— 剩余命中应只有
    `Sidebar`（若方案 031 已落地则连它也没了）、`RecentProjects`、`ResizeHandle`
    三处，**不应**再有 `AgentLog`。
  - `pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿；`pnpm build` 成功。
- **目检**（`pnpm tauri dev`，需要一个能跑长工具调用的场景——
  翻译一份长文档，或任何会上报 `ratio` 的工具）：
  - 进度线应仍从左向右生长，观感与改动前**一致**（这是判据：视觉不应变化）。
  - DevTools Performance 录制进度推进的 3 秒：改动前每次进度更新伴随 Layout；
    改动后应只有 Composite。**这是唯一能量化的判据。**
  - Layers / Rendering 面板勾选 "Paint flashing"：进度推进时**不应**再看到
    整行被重绘。
  - 进度跑到 100% 时线应恰好填满轨道、不溢出右缘。
  - 快速连续推进（一次几十块的翻译）时线应平滑跟随，不再明显滞后于文字标签里的数字。
- **Done when**：`AgentLog` 不再有 `transition: width`，视觉不变，
  Performance 面板上进度更新只剩 Composite。
