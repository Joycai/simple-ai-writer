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
| 006 | [弹出层锚定与出场方向](006-popover-anchoring.md) | MEDIUM | DONE |
| 007 | [按压反馈统一](007-press-feedback.md) | MEDIUM | DONE |
| 008 | [模态退出动画（ModalShell 单点）](008-modal-exit-via-shell.md) | MEDIUM | DONE |
| 009 | [reduced-motion 保住工作信号](009-reduced-motion-keep-progress.md) | MEDIUM | DONE |
| 010 | [仪表条合成层化](010-meters-composite.md) | MEDIUM | DONE |
| 011 | [状态变化软化（保存/视图/草稿）](011-state-change-softening.md) | LOW | DONE |
| 012 | [插入到文档落点反馈](012-insert-flash.md) | LOW | DONE |
| 013 | [剩余非壳模态表面的退出动画](013-remaining-modal-surfaces.md) | LOW | DONE |
| 014 | [⌘K 命令面板去动画（决策变更）](014-command-palette-instant.md) | MEDIUM | DONE |

> 001–005 已随 [PR #273](https://github.com/Joycai/simple-ai-writer/pull/273) 合入 main（基准 0f49132）。
> 006–012（backlog 第二批，基准 9e16885）已于 2026-08-22 执行完毕，`pnpm tsc --noEmit` 与 `pnpm build` 通过。
> 执行中的一处方案修正：008 的消费者接入必须用嵌套组件形态（详见该方案内的 ⚠ 说明）。

## 推荐执行顺序与依赖

**第一批（已完成）**：001 → 003 → 002 → 004 → 005。

**第二批（006–012）**：
1. **010**（纯机械，收掉最后的布局属性动画）
2. **009**（机械，无障碍收益直接）
3. **007**（规则化扫描，量大但模式单一）
4. **006**（弹出层，含一个小 TSX 改动）
5. **008**（ModalShell 单点改造，改动集中、需要最仔细的审查）
6. **011**（加法项，三个小软化）
7. **012**(加法项，唯一的新功能件，建议单独成 PR)

依赖关系：006 与 009 都会动 `global.css` 的关键帧块和若干相同模块文件（追加行，不冲突，但**不要并行执行**，按序即可）。其余互不依赖。

**008 的收尾已完成**：ModalShell 增补 `closeRef` prop 作为轻量接入通道（复杂模态无需拆组件），其余 10 个消费者（LoreWall ×3、LoreGenerator、LoreSplitModal、LoreMetaImproveModal、FacetEditModal、LoreImproveModal、FacetAiAssistantModal、EntityAiHubModal、SyncPreviewModal、ImageGenModal）的按钮关闭与成功后关闭全部走退出动画。

## 第三批（013–014，基准 7b95145）

原「暂不立案」两项均已立案：
- **013**：BatchRunModal / PromptViewer 迁入 ModalShell（各带特殊语义保全），Onboarding 复用 `modal-closing` 做谢幕淡出；ErrorBoundary 明确不做（崩溃表面，理由在方案内）。sync 经核实无剩余工作。
- **014**：⌘K 面板去动画是对 design-system.md 既定决策的**显式变更**，方案含文档同步步骤。建议 014 单独审阅——它改的是产品决策，不只是代码。

执行中的计划外发现（**已处理**）：`LoreDetail.tsx` 的图片灯箱曾是最后一个手卷 portal 对话框（role="dialog"，点击即关）——013 的排查步骤发现但不在其范围内。已按 013 的 PromptViewer 模式迁入 ModalShell + `closeRef`（Escape/←→ 键盘语义留在组件自己的监听里，壳传 `closeOnEscape={false}`；`role="dialog"` 落在一个 `display: contents` 包装上以保住按钮的绝对定位与背板点击）。至此 `src/components` 下不再有手卷模态 overlay。
