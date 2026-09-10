# 048 — 图片灯箱 spinner 补 reduced-motion 豁免并收敛到 0.8s（035 的漏网之鱼）

- **Status**: DONE（2026-09-10，门禁已过；产物里 1.6s 豁免声明 11 → 12）
- **Commit**: 484fe4b
- **Severity**: MEDIUM
- **Category**: 6 无障碍 / 7 内聚
- **Estimated scope**: 1 个文件（`src/components/common/ImageLightbox.module.css`），改 1 行 + 新增 8 行

## Problem

```css
/* src/components/common/ImageLightbox.module.css:47-57 — 当前 */
/* Spinner tinted for the dark scrim. `spin` is the shared global keyframe
   (styles/global.css) — module keyframes share that namespace, so it is
   referenced, never redefined here (see cssKeyframeNames.test.ts). */
.spinner {
  width: 28px;
  height: 28px;
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  animation: spin 720ms linear infinite;
}
```

`grep -n "prefers-reduced-motion" src/components/common/ImageLightbox.module.css` → 空。

这个灯箱是 `1191573`（2026-09-01「对话图片改为点击放大预览」）新增的，晚于方案 009（2026-08-22）与 035（2026-08-31）。
在系统「减弱动态效果」下，`src/styles/global.css:138-145` 的全局兜底把它压成 `animation-duration: 0.001ms; animation-iteration-count: 1`——
大图还在读，spinner 转 0.001ms 后**永久静止**，与卡死无法区分。这正是 009 与 035 各自修过的同一个缺陷。

另外 `720ms` 偏离了方案 002 定下的「统一 spinner 的 0.8s」——全库其余 spinner 是 `0.8s` / `800ms`。

## Target

```css
/* target — src/components/common/ImageLightbox.module.css:47-57 及其后 */
/* Spinner tinted for the dark scrim. `spin` is the shared global keyframe
   (styles/global.css) — module keyframes share that namespace, so it is
   referenced, never redefined here (see cssKeyframeNames.test.ts). */
.spinner {
  width: 28px;
  height: 28px;
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
/* reduced-motion 下加载指示仍需转动——静止的残环与卡死无法区分（方案 009 / 035 / 048）。
   本地类 + !important 压过 global.css 的兜底（specificity 0,1,0 > 0,0,0）。 */
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 1.6s !important;
    animation-iteration-count: infinite !important;
  }
}
```

`1.6s` = 正常 `0.8s` 的半速——「更柔」而非原速，与 009 的处方一致。

## Repo conventions to follow

- 范本（逐字同形）：`src/components/lore/SyncPresence.module.css:39-53`、`src/components/ai/AgentLog.module.css:392-397`。
- 「spinner 统一 0.8s」：方案 002。
- 与方案 047 的关系：047 若落地，全局兜底不再冻结动画，本块从「复活」变成「减速」，**仍然正确**。两份互不依赖，谁先谁后都行。

## Steps

1. `src/components/common/ImageLightbox.module.css:56` —— `animation: spin 720ms linear infinite;` 改为 `animation: spin 0.8s linear infinite;`
2. 同文件 —— 紧接 `.spinner` 规则的闭合 `}`（`:57`）之后、`/* Filename, top-left …` 注释（`:59`）之前，插入 Target 里的注释 + `@media` 块。

## Boundaries

- 只改这一个文件；**不要**顺手改其他 spinner 的时长（`CategoryMoveMenu` 的 900ms 归方案 049）。
- **不要**本地重声明 `spin`。
- **不要**改 `.overlay` 的 `fadeIn`、`.img` 的 `will-change`。
- 若摘录与代码对不上（自 484fe4b 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -n "720ms" src/components/common/ImageLightbox.module.css` → 空。
  - `pnpm exec tsc --noEmit`、`pnpm test`（含 `cssKeyframeNames.test.ts`）、`pnpm build` 通过。
  - 产物：`grep -c "animation-duration:1.6s!important" dist/assets/*.css` 的总数比改动前 **+1**。
- **接线核验**（任意可见标签页，DevTools → Rendering → Emulate `prefers-reduced-motion: reduce`）：
  在 Elements 面板里给任意元素临时加上灯箱 spinner 的哈希类名（在 Sources/Network 里的 CSS 找 `_spinner_` 且 `border-top-color: rgba(255,255,255,.85)` 的那个），然后
  `getComputedStyle(el).animationIterationCount` → `"infinite"`、`animationDuration` → `"1.6s"`；关掉模拟 → `"0.8s"`。
- **目检**（需 `pnpm tauri dev`：在对话里点开一张助手生成的大图）：开着系统「减弱动态效果」，读取期间 spinner 半速持续转动；关掉后原速。
- **Done when**：灯箱 spinner 在减动效下持续半速转动，平时 0.8s，门禁通过。
