# 035 — 两个同步 spinner 补 reduced-motion 豁免并收敛回全局 spin

- **Status**: DONE（门禁已过，目检待作者）
- **Commit**: 43b52e9
- **Severity**: MEDIUM
- **Category**: 6 无障碍 / 7 内聚
- **Estimated scope**: 2 个 CSS 文件，各约 6 行

## Problem

`src/components/settings/panes/syncPane.module.css:45-53` —— 当前代码：

```css
.dotSpin {
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--stg-border-mid);
  border-top-color: var(--stg-accent);
  animation: syncSpin 800ms linear infinite;
}
@keyframes syncSpin { to { transform: rotate(360deg); } }
```

`src/components/lore/SyncPresence.module.css:39-46` —— 当前代码：

```css
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--color-border);
  border-top-color: var(--color-sienna);
  animation: presenceSpin 800ms linear infinite;
}
@keyframes presenceSpin { to { transform: rotate(360deg); } }
```

两个都是同步状态指示器，画法都是**一枚故意不闭合的环**（`border-top-color`
与其余三边不同），它的**全部含义就是「它在转」**。

`grep -n "prefers-reduced-motion"` 在这两个文件里都返回空。于是在系统「减弱
动态效果」下，`src/styles/global.css:138-144` 的一刀切兜底：

```css
/* src/styles/global.css:138-144 — 已有 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
```

会把它们冻成**一枚静止的残环**——与「卡死了」在视觉上无法区分。这正是本仓库
**已经认识到**的失效模式：另外 **8 个** spinner 都带着逐字相同的本地豁免。

范本（`src/components/ai/AgentLog.module.css:375-382`，已有、正确）：

```css
/* reduced-motion 下加载指示仍需转动——静止的残环与卡死无法区分。
   本地类 + !important 压过 global.css 的一刀切兜底（specificity 0,1,0 > 0,0,0）。 */
@media (prefers-reduced-motion: reduce) {
  .markerSpinner {
    animation-duration: 1.6s !important;
    animation-iteration-count: infinite !important;
  }
}
```

同款豁免另见：`AiPanel.module.css:946`、`AgentChat.module.css:731`、
`ConsistencyCheck.module.css:390`、`LoreRunProgress.module.css:219`、
`RoleplayChat.module.css:1163`、`SceneTransition.module.css:402`、
`ModelProbePanel.module.css:111`。**这两个文件是漏掉的那两个。**

**并非巧合**：正是这两个把全局 `spin` 克隆成了私有名字。
`src/styles/global.css:91-93` 已有：

```css
@keyframes spin { to { transform: rotate(360deg); } }
```

三个名字、一个函数体。仓库里其余十个 spinner 直接写
`animation: spin 0.8s linear infinite`。**私有名字就是它们脱离共享模式、
进而漏掉豁免的原因**——所以这两件事在同一份方案里修。

## Target

```css
/* target — src/components/settings/panes/syncPane.module.css */
.dotSpin {
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--stg-border-mid);
  border-top-color: var(--stg-accent);
  animation: spin 800ms linear infinite;
}
/* reduced-motion 下加载指示仍需转动——静止的残环与卡死无法区分。
   本地类 + !important 压过 global.css 的一刀切兜底（specificity 0,1,0 > 0,0,0）。 */
@media (prefers-reduced-motion: reduce) {
  .dotSpin {
    animation-duration: 1.6s !important;
    animation-iteration-count: infinite !important;
  }
}
```

```css
/* target — src/components/lore/SyncPresence.module.css */
  animation: spin 800ms linear infinite;
}
/* reduced-motion 下加载指示仍需转动——静止的残环与卡死无法区分。
   本地类 + !important 压过 global.css 的一刀切兜底（specificity 0,1,0 > 0,0,0）。 */
@media (prefers-reduced-motion: reduce) {
  .dotSpin {
    animation-duration: 1.6s !important;
    animation-iteration-count: infinite !important;
  }
}
```

两个 `@keyframes`（`syncSpin` / `presenceSpin`）**整块删除**。

## Repo conventions to follow

- 豁免注释**逐字照抄** `AgentLog.module.css:375-376` 那两行——它已经在 8 处出现，
  是这条约定的规范措辞。
- 降级时长统一 `1.6s`（8 处豁免全部用这个值：正常 0.8s 的一半速度）。
- 复用全局 `spin`（`global.css:91`），**不新增关键帧**。
- 减速而非归零，正是 AUDIT §6 的「reduced motion 意味着更少更柔，而不是零」。

## Steps

1. `src/components/settings/panes/syncPane.module.css` —— `.dotSpin` 的
   `animation` 里 `syncSpin` 改成 `spin`；删掉 `:52` 的
   `@keyframes syncSpin { … }` 整行；在 `.dotSpin` 之后追加 Target 里的
   `@media (prefers-reduced-motion: reduce)` 块（含两行注释）。
2. `src/components/lore/SyncPresence.module.css` —— 同样三步：
   `presenceSpin` → `spin`，删 `:46` 的 `@keyframes presenceSpin { … }`，
   追加豁免块。**先确认该文件里那个类确实叫 `.dotSpin`**（读一眼 `:38` 附近的
   选择器名），选择器要与实际类名一致，不要照抄上一条。
3. 两个文件其余规则一字不动。

## Boundaries

- **不要**改这两个 spinner 的尺寸、颜色、边框或 800ms 常速时长。
- **不要**去动另外 8 处已有的豁免，它们是对的。
- **不要**新增关键帧；也**不要**保留 `syncSpin` / `presenceSpin` 作为别名。
- **不要**顺手给其它无限动画补豁免。审计已逐条核过全部 12 个 `infinite`
  关键帧体，其余（`blink` / `pulse` / `pulseDeep` / `writerPulse`）都是纯 opacity，
  在减动效下静止是**可接受**的降级——它们不像残环那样会被误读成卡死。
- 若代码与摘录对不上（自 43b52e9 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `grep -rn "syncSpin\|presenceSpin" src` —— **必须为空**。
  - `pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿
    （**含 `cssKeyframeNames.test.ts`**——它是删关键帧的回归网，同时会证明
    `spin` 这个引用不悬空）；`pnpm build` 成功。
  - 产物核对：`grep -ohE "@keyframes [a-zA-Z_]+" dist/assets/*.css | sort -u`
    里不应再有 `syncSpin` / `presenceSpin`；`spin` 仍在且**未作用域化**。
- **目检**（`pnpm tauri dev`）：
  - 常规模式：设置 → 同步与备份，触发一次连接/同步，确认 `.dotSpin` 仍以
    原速旋转、外观无变化；知识库墙的 `SyncPresence` 同样。
  - **开启系统「减弱动态效果」**（macOS：系统设置 → 辅助功能 → 显示 → 减弱动态效果），
    重新触发同步：两个指示器都应**继续旋转**，只是慢一半（1.6s/圈）。
    **这是本方案的核心判据**——改动前它们会冻成静止残环。
  - 同一状态下确认其余动效仍被全局规则压成瞬时（本方案不应放宽全局策略）。
- **Done when**：两个私有关键帧名在全库消失，减动效下两个指示器仍在转。
