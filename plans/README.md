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
| 015 | [右键菜单入场（006 的漏网之鱼）](015-context-menu-entrance.md) | MEDIUM | APPLIED · 受阻断 A |
| 016 | [审批卡入场](016-approval-card-entrance.md) | MEDIUM | APPLIED · 受阻断 A |
| 017 | [首次运行向导换步 enter-only](017-onboarding-step-enter-only.md) | LOW | **BLOCKED · 阻断 B** |
| 018 | [导出按钮回执淡入](018-export-feedback-fade.md) | LOW | APPLIED · 受阻断 A |

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

## 第四批（015–018，基准 78160c2）

来源不是新一轮审计，而是一次 `find-animation-opportunities` 勘察（找「该动而没动」的地方，与前三批「已有动效哪里不对」互补）。勘察提了 5 条，**立案 4 条，撤回 1 条**。

- **015**：`ContextMenu` 是方案 006 那份锚定弹出层清单的漏网之鱼——全应用唯一既无入场也无 `transform-origin` 的锚定浮层，却被 8 个调用点共用。改动是 2 行 CSS，杠杆最高，建议先做。
- **016**：agent 审批卡（写手稿 / 写设定 / 轮次上限）落地时一帧硬切，而那正是循环停住等作者点头的一刻。方案内说明了它为什么不违反「AgentChat 流式行刻意不做入场动画」那条既有约定。
- **017**：首次运行向导的换步是硬切（013 只补了谢幕淡出，没碰中间）。**必须用 enter-only**，方案内两次引用了否决 `mode="wait"` 的既有记录（方案 004 + `AiPanel.tsx:1410` 注释）。
- **018**：导出按钮是全应用唯一的成功回执（`ExportMenu.tsx:9` 注释自陈），却硬切且会推动标题栏。第 3 步（宽度兜底）是**条件性**的，要求先实测中英文四种状态的宽度再决定改不改，不许凭猜写 `min-width`。

**撤回的一条**：勘察曾建议给 `InlineAiBubble` 加 120ms 入场。经查，方案 003（DONE）**正是刻意删掉**了它原有的 `scaleIn 160ms`——该组件由 `selectionchange` 驱动、每次选区变化都 `return null` 后重挂载，动画会在写作核心手势上反复重放。003 的判断比勘察更准，**不要重新加回去**。同理，`MentionPicker` / `AttachmentTextarea` / `SearchPanel` 的无动画状态也是 003/006 的既定结论，不是缺口。

### 推荐执行顺序与依赖

1. **015**（2 行 CSS，纯机械，零风险）
2. **016**（1 条 CSS 规则；验证时务必跑「同一运行内第二张卡」那条回归）
3. **018**（含一步实测，可与 015/016 并行）
4. **017**（唯一的 TSX 结构改动，且需要触发首次运行向导才能验证，建议单独成 PR）

四份互不依赖，改动文件零重叠（`ContextMenu.module.css` / `AgentChat.module.css` / `TitleBar.module.css`+`ExportMenu.tsx` / `Onboarding.tsx`），可并行执行。**均不改 `global.css`**——四份复用的 `dropIn`、`fadeIn`、`panelFade` 都已存在，任何一份若打算新增关键帧或 Motion 预设，都说明理解偏了。

## ⚠ 执行 015–018 时实测到的两个既有阻断（2026-08-23，基准 36eda7b）

两个都**先于第四批存在**，且都是实机跑出来的，不是读代码推的。

### 阻断 A —— CSS Modules 把 keyframe 名作用域化，37 处动画引用是死的

方案 006、011 以及第四批全部四份都写过同一句话：「模块引用本文件未声明的动画名会透传到全局」。**这句是错的。**

`dist/assets/*.css` 里，关键帧定义是全局名，而 `.module.css` 里的引用被 Vite 加了作用域后缀，两边对不上：

```
@keyframes dropIn                              ← global.css 定义（未作用域化）
animation:_dropIn_1by8j_1 .14s var(--ease-out) ← ContextMenu.module.css 的引用
```

全量核对构建产物：**38 处模块动画引用里 37 处没有对应定义** —— `fadeIn` 17 · `scaleIn` 11 · `dropIn` 5 · `riseIn` 3 · `slideInRight` 1。指向全局关键帧的未作用域化引用 **0 处**。唯一活着的是 `_transitionGrow_1km2h_1`，因为 `SceneTransition.module.css` **自己定义**了它。

影响面远超第四批：方案 006 的四个弹出层入场、各模态的 `scaleIn`/`fadeIn` 入场**从未真正跑过**。
**但方案 008 的退场动画是好的** —— `.modal-closing` 定义在 `global.css` 且以字符串类名套用（不经 `styles.x`），没被作用域化，构建产物里保持 `animation:fadeOut .16s`。这条差别正是判断某个动画到底活没活着的判据。

修复方向：引用侧加 `:global(...)`。**但它会一次性点亮 37 个动画**，是对已发布外观的实质改动，必须单独成 PR 并做一轮外观审阅——不要顺手塞进别的改动里。**改之前先按上面的方法核对构建产物，别再凭约定断言。**

### 阻断 B —— enter-only 的 keyed `motion.div` 在 reduced-motion 下停在 `initial`

开着 Reduced Motion 跑起来，侧栏面板此刻在 `main` 上就是全透明的：

```
_contentFlush_1wdy8_102  →  computedOpacity "0"   239×672
                            inline: "opacity: 0; transform: translateY(6px);"
```

切换 文件/大纲 标签、等 1.2s 后依旧是 0 —— 不是时序问题，是永久的。同一棵树里被 `AnimatePresence` 包着的 `fillLayer` 则正常收敛到 `opacity: 1`。

即：**方案 004 引入的 enter-only 模式（keyed `motion.div` + `initial`/`animate`，无 `AnimatePresence`）在 `MotionConfig reducedMotion="user"` 下不会推进到 `animate`。** 侧栏对所有开启动效缩减的用户是不可见的 —— 这是无障碍缺陷，不只是动效问题。

017 会把同一缺陷复制到首次运行向导（已实测确认同样停在 `opacity: 0`），所以**017 已回退、标记 BLOCKED**：让首屏对这部分用户完全不可见，比它原本的硬切更糟。修好 B 之后 017 可原样执行，方案本身不用改。
