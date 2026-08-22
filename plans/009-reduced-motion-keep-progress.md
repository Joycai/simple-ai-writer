# 009 — reduced-motion 下保住「仍在工作」信号

- **Status**: DONE (2026-08-22)
- **Commit**: 9e16885
- **Severity**: MEDIUM
- **Category**: 无障碍
- **Estimated scope**: ~9 个 CSS 文件，每处 +3 行

## Problem

全局 reduced-motion 块是一刀切：

```css
/* src/styles/global.css:87-94 附近 — 现状 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
```

`animation-iteration-count: 1` 不是让加载 spinner 变温和，而是让它转 0.001ms 后**永远静止**——对减动效用户，一次长流式生成期间「模型还在工作」的首要信号变成一个冻结的残环，与卡死无法区分。审计准则（AUDIT §6）明确：reduced motion 是「更少更柔」，**不是零反馈**；帮助理解状态的动画应该保留。

方案 002 之后所有 spinner 都统一为全局 `spin 0.8s linear infinite`，共 10 个使用点（`grep -rn "spin 0.8s" src/components --include=*.css`）：AgentLog、AgentChat、AiPanel（×2）、ConsistencyCheck、ModelProbePanel、RoleplayChat、SceneTransition、LibraryView、LoreRunProgress。

CSS Modules 的类选择器（specificity 0,1,0）带 `!important` 时**能压过**全局 `*`（0,0,0）的 `!important`——四个文件里已有的本地 reduced-motion 块（如 `RoleplayChat.module.css` 的 `.spinner, .streamDot { animation: none; }`）正是靠这个生效的。所以恢复 spinner 不需要动 TSX，也不需要改全局块：**在每个 spinner 的模块 CSS 里加一个本地恢复块**。

## Target

全局块保持不动（一刀切兜底仍然正确：入场动画、位移、脉冲都该停）。每个 spinner 类所在的模块 CSS 追加：

```css
/* reduced-motion 下加载指示仍需转动——静止的残环与卡死无法区分。
   本地类 + !important 压过 global.css 的一刀切兜底（specificity 0,1,0 > 0,0,0）。 */
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 1.6s !important;
    animation-iteration-count: infinite !important;
  }
}
```

（`.spinner` 代指各文件中真实的 spinner 类名；`1.6s` = 正常 0.8s 的一半速——「更柔」而非原速。）

**例外**：`RoleplayChat.module.css` 现有块把 `.spinner` 设为 `animation: none`——把 `.spinner` 从那个 `none` 列表移出、按上式恢复，`.streamDot`（脉冲点，非首要信号）保持 `none`。

## Repo conventions to follow

- 本地 reduced-motion 覆盖块的先例：`ModelProbePanel.module.css`、`RoleplayChat.module.css`、`ScriptText.module.css`、`RoleplayRoster.module.css` 文件尾部。
- 只恢复 spinner；脉冲点、闪烁光标、入场动画一律维持全局冻结（它们不是唯一的工作信号）。

## Steps

1. 跑 `grep -rn "spin 0.8s" src/components --include=*.css`，得到全部 spinner 规则及其类名（Problem 里的 10 处清单以 grep 为准）。
2. 对每个文件：在文件末尾（或已有的 reduced-motion 块内）加上 Target 的恢复规则，类名换成该文件的真实 spinner 类名。同一文件多个 spinner 类（AiPanel）写进同一个块。
3. `RoleplayChat.module.css`：按 Target 的例外处理——已有块中 `.spinner` 移出 `animation: none` 列表，改为恢复规则；`.streamDot` 不动。
4. 自查每个新块的选择器确实是**类**选择器（保证压过全局 `*`）。

## Boundaries

- 不改 `global.css` 的全局 reduced-motion 块本身。
- 不恢复任何非 spinner 动画（`pulseDeep`、`blink`、入场帧统统保持冻结）。
- 不动 TSX。
- 若某文件的 spinner 类名或已有 reduced-motion 块与预期不符，停下报告该文件、其余照常。

## Verification

- **Mechanical**: `pnpm tsc --noEmit`、`pnpm build` 通过。
- **Feel check**: `pnpm dev`，DevTools → Rendering → Emulate `prefers-reduced-motion: reduce`：
  - 触发一次 AI 生成：面板 spinner 应以半速持续转动（修改前：转一下就冻住）。
  - 同屏确认流式光标、脉冲点、模态入场仍然是静止/瞬时的（兜底未被误伤）。
  - 关掉模拟：spinner 回到 0.8s 原速。
- **Done when**: reduced-motion 下所有加载 spinner 半速持续转动，其余动画维持冻结。
