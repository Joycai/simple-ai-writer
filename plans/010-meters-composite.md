# 010 — 仪表条不再动画布局属性（width / flex-grow）

- **Status**: DONE (2026-08-22)
- **Commit**: 9e16885
- **Severity**: MEDIUM
- **Category**: 性能
- **Estimated scope**: 3 个 CSS 文件 + 2 个 TSX，各 1-3 行

## Problem

三条仪表在动画布局属性，每次推进都触发 layout+paint 而不是合成层插值——且都恰好在最忙的时刻运行（AI 流式生成中 / 同步批量推进中 / agent 每轮结算时）：

**A. AiPanel 故事记忆覆盖率条**——`width` 过渡：

```css
/* src/components/ai/AiPanel.module.css:367-378 — 现状 */
.progressTrack {
  height: 3px;
  background: var(--color-bar-track);
  overflow: hidden;
}
.progressFill {
  display: block;
  height: 100%;
  background: var(--color-success-bar);
  transition: width var(--transition-base);
}
```
```tsx
// src/components/ai/AiPanel.tsx:451-456 — 现状
      <div className={styles.progressTrack}>
        <span
          className={`${styles.progressFill} ${staleCount > 0 ? styles.progressFillStale : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
```

**B. 同步进度条**——同病（`sync.module.css` 的 `.trackFill`，`transition: width var(--transition-base)`；宽度由 `SyncPreviewModal.tsx:141-144` 的 `style={{ width: ... }}` 驱动）。

**C. 聊天上下文构成条**——`flex-grow` 过渡，六段同时 reflow，恰在每轮 agent 结算、流式转录还在增长时触发：

```css
/* src/components/ai/AgentChat.module.css:314-318 — 现状 */
.ctxSeg {
  display: block;
  min-width: 1px;
  transition: flex-grow var(--transition-base);
}
```
```tsx
// src/components/ai/ContextBar.tsx:72-81 — 现状（flexGrow 按 token 数分配）
          <span
            key={seg.key}
            className={`${styles.ctxSeg} ${styles[`ctxSeg_${seg.key}`]}`}
            style={{ flexGrow: seg.tokens }}
```

## Target

**A/B 改 `transform: scaleX()`**——填充层宽度固定 100%，用缩放表达百分比，合成层插值：

```css
/* AiPanel.module.css — 目标 */
.progressFill {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--color-success-bar);
  transform-origin: left;
  transition: transform var(--transition-base);
}
```
```tsx
// AiPanel.tsx — 目标（width → scaleX，pct 是 0-100）
          style={{ transform: `scaleX(${pct / 100})` }}
```
sync 的 `.trackFill` 同款：CSS 加 `width: 100%; transform-origin: left;`、`transition` 的 `width` 换 `transform`；`SyncPreviewModal.tsx:143` 的 `width: \`${x}%\`` 改 `transform: \`scaleX(${x / 100})\``（x 保持原来的 0-100 计算，除以 100）。注意 `.trackFill` 现有的 `inset: 0 auto 0 0` 定位保留。

**C 直接删过渡**——flex 布局输入没有合成层等价物，六段各 200ms 的补间只是把一次 reflow 摊成十几次；上下文构成每轮只变一次，瞬时更新即可：

```css
/* AgentChat.module.css — 目标 */
.ctxSeg {
  display: block;
  min-width: 1px;
}
```

## Repo conventions to follow

- 「只动画 transform/opacity」是本轮审计的既定基线（方案 005 刚清完 `left`/`transition: all`）。
- `--transition-base: 200ms var(--ease-out)`（tokens.css）——A/B 保持这个时长曲线不变，只换属性。

## Steps

1. `src/components/ai/AiPanel.module.css`：`.progressFill` 按目标改（加 `width: 100%; transform-origin: left;`，`transition: width` → `transition: transform`）。
2. `src/components/ai/AiPanel.tsx`：`style={{ width: \`${pct}%\` }}` → `style={{ transform: \`scaleX(${pct / 100})\` }}`。
3. `src/components/sync/sync.module.css`：找到 `.trackFill`（`transition: width var(--transition-base)` 所在规则），同款改法，保留 `inset` 定位。
4. `src/components/sync/SyncPreviewModal.tsx`：`width` 内联样式改 `scaleX`（原表达式算出的 0-100 值除以 100）。
5. `src/components/ai/AgentChat.module.css`：`.ctxSeg` 删除 `transition: flex-grow var(--transition-base);` 一行。

## Boundaries

- 不动 `.progressTrack` / `.track` 容器、`.ctxMark` 标记、颜色映射。
- 不改 pct/progress 的计算逻辑，只改表达方式。
- 若某处与摘录不符（相对 9e16885 有漂移），停下报告该处、其余照常。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过；`grep -rn "transition: width\|transition: flex-grow" src/ --include=*.css` 零命中。
- **Feel check**: `pnpm dev`：
  - AI 面板记忆覆盖率条推进：视觉与之前一致（自左向右平滑增长，200ms）。
  - DevTools Rendering → Paint flashing：条推进时填充层不再触发重绘矩形。
  - 聊天上下文条在一轮 agent 后更新：各段瞬时到位，无中间抖动。
  - 同步一个知识库：进度条平滑推进、行为不变。
- **Done when**: 两条进度条走 scaleX、上下文条无布局过渡，视觉终态与修改前一致。
