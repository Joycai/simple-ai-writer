# 002 — 修复失效的 rp-pulse 并把克隆的关键帧收进 global.css

- **Status**: DONE (2026-08-22)
- **Commit**: 0f49132
- **Severity**: HIGH（含一个真 bug）
- **Category**: 一致性与令牌
- **Estimated scope**: ~10 个 CSS 文件，纯机械替换

## Problem

**真 bug**：`RoleplayChat.module.css:430` 引用了 `rp-pulse`，但这个关键帧只定义在 `RoleplayRoster.module.css:296`。CSS Modules 默认把 `@keyframes` 名按文件哈希隔离（`vite.config.ts` 没有覆盖 `css.modules`），跨文件引用解析不到任何东西——**扮演回复流式进行时，旁边的圆点根本不闪**，静默失效。

```css
/* src/components/roleplay/RoleplayChat.module.css:426-431 — 现状（死动画） */
.streamDot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-accent);
  animation: rp-pulse 1.4s infinite;
}
```

同一机制下，仓库里还堆着大量克隆：

- **10 份一模一样的 spinner 关键帧**（`to { transform: rotate(360deg); }`），跑在 5 种不同速度上——AI 面板和扮演面板同屏时两个 spinner 转速肉眼可见地不一致：
  - `agentLogSpin 0.7s`（AgentLog.module.css:325）、`aiPanelDraftSpin 0.7s`（AiPanel.module.css:757）
  - `chatSpin 0.8s`（AgentChat.module.css:188）、`aiPanelSpin 0.8s`（AiPanel.module.css:700）、`consistencySpin 0.8s`（ConsistencyCheck.module.css:207）
  - `transitionSpin 0.9s`（SceneTransition.module.css:241）、`memoSpin 0.9s`（LibraryView.module.css:429）、`lrSpin 0.9s`（LoreRunProgress.module.css:22）
  - `probeSpin 1s`（ModelProbePanel.module.css:107）、`rp-spin 1.1s`（RoleplayChat.module.css:572）
- `global.css:51-74` 已有共享关键帧块（fadeIn/scaleIn/slideUp/slideInRight/blink/pulse），但 `blink` 有 3 份本地克隆（LoreRunProgress.module.css:221 `lrBlink`、ScriptText.module.css:74 `rp-blink`、AiPanel.module.css:787 `aiPanelBlink`），`pulse` 有 1 份（LoreRunProgress.module.css:112 `lrPulse`），`fadeIn` 有 1 份逐字节相同的克隆（LoreDetail.module.css:777）。

CSS Modules 的通行机制：模块里引用**本文件未声明**的动画名会原样透传，正好命中 `global.css` 的全局关键帧——`Select.module.css:60` 引用全局 `slideUp` 就是这么工作的。所以「删本地克隆、引用全局名」是零风险替换。

## Target

1. `global.css` 关键帧块新增两个共享关键帧：

```css
/* src/styles/global.css — 在 @keyframes pulse 之后追加 */
@keyframes spin {
  to { transform: rotate(360deg); }
}
/* 深谷值脉冲 — 直播状态圆点（扮演花名册/流式指示）用 */
@keyframes pulseDeep {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
```

2. 所有 spinner 统一为 `animation: spin 0.8s linear infinite;`（取现存值的中位数），删除 10 份本地 spin 关键帧。
3. `rp-pulse`/`transitionPulse`（谷值 0.35 的）→ `pulseDeep`；`lrPulse`（谷值 0.5）→ 全局 `pulse`；`lrBlink`/`rp-blink`/`aiPanelBlink` → 全局 `blink`；LoreDetail 本地 `fadeIn` 克隆直接删除（引用自动落到全局同名帧）。时长保持各处原值不变（只统一 spinner 的 0.8s）。

## Repo conventions to follow

- 共享关键帧的家是 `src/styles/global.css:50-74`（文件顶部注释 "Reusable entrance animations"），新帧加在这个块里。
- 模块内引用全局关键帧的先例：`src/components/common/Select.module.css:60`（`animation: slideUp 160ms var(--ease-out);`，本文件无同名声明）。

## Steps

1. `src/styles/global.css`：按上文目标代码在 `@keyframes pulse`（第 71-74 行）后追加 `spin` 和 `pulseDeep`。
2. 逐文件替换 spinner（每处：改 `animation:` 行的关键帧名为 `spin`、时长为 `0.8s`，再删除该文件里对应的 `@keyframes` 声明）：
   - `src/components/ai/AgentLog.module.css:325`（`agentLogSpin 0.7s` → `spin 0.8s`；删除 :14 的声明）
   - `src/components/ai/AgentChat.module.css:188`（`chatSpin` → `spin`；删除 :190 的声明）
   - `src/components/ai/AiPanel.module.css:700` 与 `:757`（两处都 → `spin 0.8s`；删除 :702、:759 的声明）
   - `src/components/ai/ConsistencyCheck.module.css:207`（删除 :209 声明）
   - `src/components/settings/ModelProbePanel.module.css:107`（`probeSpin 1s` → `spin 0.8s`；删除 :109 声明）
   - `src/components/roleplay/RoleplayChat.module.css:572`（`rp-spin 1.1s` → `spin 0.8s`；删除 :1151 声明）
   - `src/components/roleplay/SceneTransition.module.css:241`（删除 :244 声明）
   - `src/components/library/LibraryView.module.css:429`（`memoSpin 0.9s` → `spin 0.8s`；删除 :431 声明）
   - `src/components/lore/ai/LoreRunProgress.module.css:22`（`lrSpin 0.9s` → `spin 0.8s`；删除 :26 声明）
3. 脉冲/闪烁收敛：
   - `src/components/roleplay/RoleplayChat.module.css:430`：`rp-pulse` → `pulseDeep`（这一步修复死动画）。
   - `src/components/roleplay/RoleplayRoster.module.css:214`：`rp-pulse` → `pulseDeep`；删除 :296 的 `@keyframes rp-pulse`。
   - `src/components/roleplay/SceneTransition.module.css:273`：`transitionPulse` → `pulseDeep`；删除 :276 的声明。
   - `src/components/lore/ai/LoreRunProgress.module.css:107`：`lrPulse` → `pulse`；删除 :112 的声明。
   - `src/components/lore/ai/LoreRunProgress.module.css:221` 区域：`lrBlink` 引用 → `blink`；删除本地声明。
   - `src/components/roleplay/ScriptText.module.css:71` 区域：`rp-blink` 引用 → `blink`；删除 :74 的声明。
   - `src/components/ai/AiPanel.module.css:784` 区域：`aiPanelBlink` 引用 → `blink`；删除 :787 的声明。
   - `src/components/lore/LoreDetail.module.css:777`：删除本地 `@keyframes fadeIn` 克隆（:775 的 `animation: fadeIn 120ms ease-out;` 同时改为 `fadeIn 120ms var(--ease-out)`，与全库其余写法一致）。
4. 检查各文件自带的 `@media (prefers-reduced-motion: reduce)` 块（ModelProbePanel.module.css:113、RoleplayChat.module.css:1153、ScriptText.module.css:79、RoleplayRoster.module.css:301）：它们只写 `animation: none`，不引用被删的关键帧名的话原样保留；若引用了已删名字，同步更新为新名字。

## Boundaries

- 只动 `@keyframes` 声明和 `animation:` 引用行；不改任何元素的尺寸、颜色、布局属性。
- 不改 pulse/blink 类动画的时长（只统一 spinner 到 0.8s）。
- 不动 `global.css` 现有六个关键帧的内容。
- 若某行与摘录不符（相对 0f49132 有漂移），停下报告。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过；`grep -rn "keyframes" src/components | grep -iv "media"` 应不再出现 spin/blink/pulse/fadeIn 的本地克隆。
- **Feel check**: `pnpm dev`：
  - 开一个扮演会话让角色流式回复：消息旁的圆点**现在应该在闪**（修复前完全静止）。
  - 同屏打开 AI 面板生成 + 任一其他 spinner：所有 spinner 转速一致。
  - DevTools Animations 面板放慢 10%：确认 spinner 是匀速（linear）旋转。
- **Done when**: streamDot 恢复脉冲，全库 spinner 同速，`src/components` 下不再有 spin/blink/pulse/fadeIn 克隆。
