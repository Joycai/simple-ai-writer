# 动画改进方案（improve-animations 审计产出）

审计基准提交：`0f49132`（2026-08-22）。每个方案自包含，可交给任意执行代理（含低成本模型）：
`improve-animations execute <plan>`，或直接按方案文件操作。

## 方案一览

| # | 方案 | 严重度 | 状态 |
| --- | --- | --- | --- |
| 001 | [拖拽侧栏宽度时禁用 width 过渡](001-sidebar-resize-drag.md) | HIGH | DONE |
| 002 | [修复失效的 rp-pulse 并收敛克隆关键帧](002-shared-keyframes-dead-pulse.md) | HIGH | DONE |
| 003 | [删掉高频/键盘表面的入场动画](003-quiet-high-frequency-surfaces.md) | HIGH | DONE |
| 004 | [侧栏标签切换去掉 mode="wait"](004-sidebar-tab-enter-only.md) | MEDIUM | DONE |
| 005 | [合成层友好属性 + 令牌归位](005-composite-props-and-tokens.md) | MEDIUM | DONE |

> 全部 5 个方案已于 2026-08-22 在工作树执行完毕（未提交），`pnpm tsc --noEmit` 与 `pnpm build` 通过。

## 推荐执行顺序与依赖

1. **001**（最小改动、体感提升最大）
2. **003**（纯删行，零风险）
3. **002**（机械替换但文件多；注意它会删除 MentionPicker 的本地 `slideUp`——若 003 已先执行，其中一步已完成，跳过即可）
4. **004**（单文件）
5. **005**（机械批量）

依赖关系：003 与 002 在 `MentionPicker.module.css` 上有一处重叠（本地 `slideUp` 克隆的删除），先执行者完成该步，后执行者跳过。其余方案互不依赖，可并行。

## 审计中记录但未成案的事项（后续可再出方案）

- 弹出层缺 `transform-origin` / 出场方向与锚点相悖（Select 上翻仍上滑、AiDrawer 会话菜单向下挂却向上滑等）。
- 约 15 处 `:active` 按压缩放未把 `transform` 列入 transition（按压硬跳）；若干缩放超出 0.95–0.98 区间；高频按钮（图标栏、右键菜单、命令面板行）完全没有按压反馈。
- 11 个模态仍是 mount-only CSS 入场、关闭硬切——`lib/motion.ts:72-76` 注释声称的 AnimatePresence 迁移只完成了一半。
- 全局 `prefers-reduced-motion` 块把 spinner 冻成静止残环（`animation-iteration-count: 1`），削弱「仍在工作」信号——需要产品决策而非直接修。
- 进度条动画 `width`、聊天上下文条动画 `flex-grow`（布局属性）。
- 遗漏的动画机会：编辑/分栏/预览视图切换硬切、AI 多稿切换整页文本瞬换、「插入到文档」无任何落点反馈、保存圆点颜色瞬跳。
