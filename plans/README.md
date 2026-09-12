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
| 015 | [右键菜单入场（006 的漏网之鱼）](015-context-menu-entrance.md) | MEDIUM | DONE（阻断 A 已解除） |
| 016 | [审批卡入场](016-approval-card-entrance.md) | MEDIUM | DONE（阻断 A 已解除） |
| 017 | [首次运行向导换步 enter-only](017-onboarding-step-enter-only.md) | LOW | TODO（阻断 B 已澄清解除） |
| 018 | [导出按钮回执淡入](018-export-feedback-fade.md) | LOW | DONE（阻断 A 已解除） |
| 019 | [模块内 @keyframes 的全局唯一性守卫](019-keyframe-namespace-guard.md) | LOW | DONE |
| 020 | [集合/装订子系统补齐悬停过渡](020-collections-transitions.md) | MEDIUM | DONE |
| 021 | [侧栏拖拽按帧合并写入](021-sidebar-drag-raf.md) | MEDIUM | DONE |
| 022 | [令牌归位与关键帧去重（005 的漏网之鱼）](022-token-and-keyframe-cleanup.md) | LOW | DONE |
| 023 | [阻断 B 重新归因](023-blocker-b-reattribute.md) | HIGH | DONE — 结论「不是缺陷」，走分支 A |
| 024 | [「回到最新」气泡去掉入场动画](024-jump-latest-no-entrance.md) | LOW | DONE |
| 025 | [取材范围切换的墙面软化（加法项）](025-wall-scope-switch-softening.md) | LOW | DONE（第 2 步已按判据撤回） |
| 026 | [审批卡入场：补齐 016 漏掉的两个挂载点](026-approval-card-entrance-remaining.md) | MEDIUM | DONE |
| 027 | [一致性检查结果统一淡入落位](027-consistency-findings-stagger.md) | MEDIUM | DONE |
| 028 | [生成图落位时淡入显影](028-generated-image-reveal.md) | LOW | DONE |
| 029 | [提示词库痕迹行补上退场淡出](029-snippet-trace-exit.md) | MEDIUM | DONE |
| 030 | [「跳到结尾」的光标落点提示](030-caret-landing-flash.md) | LOW | DONE（目检待作者） |

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

### 阻断 A —— **已解决**（2026-08-23 切 LightningCSS）

> **原文所述缺陷已修复，本节保留为记录。** 当时的诊断是对的：CSS Modules 会把
> `.module.css` 里的动画名哈希掉，而 keyframes 定义留在非 module 的 `global.css`
> 里名字没变，38 处模块动画引用有 37 处悬空、一帧没播过。
>
> 修法落在 `vite.config.ts:26-35`（改用 LightningCSS + `cssModules: { animation: false }`
> 关掉动画名哈希），并写进了 `docs/issues/css-modules-global-keyframes.md`。
>
> **2026-08-26 复核（基准 93eb7de）**，按原文自己给的判据核对构建产物：
>
> ```
> $ grep -ohE "@keyframes [a-zA-Z_]+" dist/assets/*.css | sort -u   →  22 个，全部未作用域化
> $ grep -ohE "animation:[^;}]+"      dist/assets/*.css             →  全部形如 animation:fadeIn .2s var(--ease-out)
> 带作用域后缀（_fadeIn_<hash>_1 那种）的引用                        →  0 处
> ```
>
> 即：**方案 006 的四个弹出层入场、各模态的 `scaleIn`/`fadeIn` 入场现在都真的在
> 播。** 原文里「修复方向：引用侧加 `:global(...)`，会一次性点亮 37 个动画，
> 必须单独成 PR」那段已经作废——不要再按它动手。
>
> 代价是那次修复引入了一条新的、当时只靠注释约定守着的不变量：模块内的
> `@keyframes` 也不再作用域化，与 `global.css` **共用一个全局命名空间**，重名会
> 静默覆盖。落地时全库 3 个模块内 keyframes，到 93eb7de 已是 10 个。
> **方案 019 把这条约定变成测试。**

### 阻断 B —— **已澄清：不是缺陷**（2026-08-26 实测）

> 原记录：开着 Reduced Motion 跑起来，侧栏面板内容永久停在 `opacity: 0`，
> 结论是「enter-only 的 keyed `motion.div` 在 `MotionConfig reducedMotion="user"`
> 下不会推进到 `animate`」，并据此把方案 017 回退。
>
> **归因是错的。** 那次读数里内联样式带着 `transform: translateY(6px)`，而
> `useMotionPreset()`（`src/lib/motion.ts:41-54`）在减动效下的唯一职责就是剥掉
> 它——若减动效那条路径真的生效了，那串样式不可能存在。真正的成因是**测量环境**：
> 浏览器预览面板的标签页 `visibilityState === 'hidden'`，rAF 不派发、动画时间轴
> 根本不推进，于是任何 `motion.div` 都会永久停在它的 `initial` 值上。
>
> 2026-08-26 在一个**可见**页面里用 CDP + Web Animations API 重测，两种模式都
> 收敛：
>
> ```
> 基线（reduced:false）→ inline "opacity: 1; transform: translateY(0px);"  opacity 1
> 减动效（reduced:true）→ inline "opacity: 1;"（transform 已被剥掉）        opacity 1
> ```
>
> 完整读数、方法、以及仍未覆盖的一格（真 Tauri 窗口 + 系统「减弱动态效果」）
> 见 **`docs/issues/motion-enter-only-hidden-tab.md`**。
>
> **方案 017 的 BLOCKED 已解除**（状态改回 TODO，方案内容不用改）。
> `Sidebar.tsx` / `AiPanel.tsx` 未做任何改动。

## 第五批（019–025，基准 93eb7de）

来源是 2026-08-26 的一轮完整复核 + 增量审计。前三批把明显的问题清干净了：全库
**无** `transition: all`、**无** `ease-in`、**无** `scale(0)`、**无**动画布局属性
（除 022 的 E 项）、67 处 `:active` 按压反馈、锚定浮层的 `transform-origin` 全部
就位、`springScreen`/`springPanel`/`springDrawer` 三个弹簧全部处于临界阻尼或过
阻尼（无弹跳，符合手稿气质）。**新发现集中在第四批基线之后新增的代码**——新代码
没接上既有约定，而不是既有约定错了。

复核结论另有两条，写在上面的「阻断」两节里：**阻断 A 已解决**（构建产物核验通过，
原文的修复方向已作废），**阻断 B 归因存疑**（方案 023 的第一步是重新测量）。

- **019**：阻断 A 的修法把模块内 `@keyframes` 并进了全局命名空间，`vite.config.ts`
  和 issue 文档都还写着「目前只有 3 个」，实际已是 10 个。重名会**静默**覆盖全局
  关键帧——和原缺陷一样无症状。把约定变成测试。**纯加法，零风险，先做。**
- **020**：集合/装订（设计稿屏 24–31）是最新落地的一整套 UI，两个 CSS 文件
  **零 `transition:` 声明**，17 处悬停/选中全是硬切，紧挨着的分类栏却是 120ms
  淡入。量最大但模式单一。
- **021**：方案 001 关掉了拖拽期间的过渡，没碰**写入频率**——`mousemove` 跟随鼠标
  采样率直通，每次都在布局根节点写 `--sidebar-width`，一帧之内可能重复做好几次
  「样式重算 + 编辑器整列回流」。合并到 rAF。
- **022**：方案 005 那批的漏网之鱼，六处，同一类修法：两处手写 `cubic-bezier`
  复刻 `--ease-out`、两个 `fadeIn` 的逐字克隆、一个 `slideInRight` 的近似克隆 +
  冗余令牌回退、一处同款控件两个时长、一处动画 `border-width`。
- **023**：见阻断 B。**第一步是测量，不是修复**；它也是方案 017 解锁的前提。
- **024**：「回到最新」气泡有入场无退场，且由 `useStickToBottom` 的单阈值判定
  （`EDGE=40`，无滞回，另挂一个 `ResizeObserver`）驱动，边界附近会反复重挂载、
  关键帧每次从零重放。修法是**删掉入场**（同方案 003 对 `InlineAiBubble` 的判断）。
- **025**：唯一的加法项。第 2 步（卡片错峰）是**条件性**的，带三条实测判据，
  不成立必须撤回——照方案 018 第 3 步的体例。

### 推荐执行顺序与依赖

1. **019**（纯加法：一个测试 + 两处注释更新，零风险；它守的不变量后面几份都会碰到）
2. **020**（机械，量大模式单一，改动集中在 `collections/` 两个文件）
3. **021**（一处 rAF 合并 + `ResizeHandle` 加一个可选回调，收益直接落在拖拽手感上）
4. **022**（机械批量；**若 019 已落地，022 删掉三个克隆关键帧后跑一次那个测试**）
5. **023**（**先测量**。结论可能是「不是缺陷」，那就只改文档 + 解锁 017）
6. **024**（删 1 行 + 删 1 个关键帧）
7. **025**（加法项，两步，第 2 步条件性；建议单独成 PR）

依赖关系：

- **019 → 022 / 024**：这两份都会删关键帧定义，019 的测试正好是它们的回归网。
  反过来也成立——019 必须在删除之前落地，才能证明它真的会报错。顺序即可，
  不必合并。
- **023 → 017**：017 的 BLOCKED 只能由 023 解除。**023 出结论前不要执行 017。**
- 其余互不依赖，改动文件零重叠（`019` 新建测试 + `vite.config.ts` 注释 /
  `020` `collections/*.module.css` / `021` `App.tsx`+`ResizeHandle.tsx` /
  `022` 四个 CSS / `024` `AgentChat.module.css` / `025` `LoreWall.*`），可并行。
- **均不新增 `global.css` 的关键帧，也不新增 Motion 预设。** 020/022/024/025 复用的
  `fadeIn`、`slideInRight` 都已存在；任何一份若打算新增，都说明理解偏了。

### 执行记录（2026-08-26，基准 93eb7de）

019–025 已全部执行完毕。`pnpm tsc --noEmit` / `pnpm test`（188 文件 · 2551 用例）/
`pnpm build` 全绿。

- **019** 新增 `src/lib/__tests__/cssKeyframeNames.test.ts`（2 条断言），并做了两次
  **反向验证**：临时给 `SnippetSaveMenu.module.css` 加一个重名 `@keyframes fadeIn`
  → 第一条如实报出 `fadeIn — …SnippetSaveMenu.module.css / …global.css`；临时把
  `dropIn` 拼成 `dropInn` → 第二条如实报出悬空引用。两次都已还原。
  `vite.config.ts` 与 `docs/issues/css-modules-global-keyframes.md` 的过期计数一并更新。
- **020** 13 处过渡，全部落在**基态**选择器上、全部逐属性列出、零 `all`。
  三条判断按方案执行：`.railRowOn` 的 `padding-left` 未进过渡（3px 边框 + 15px
  padding = 18px，内容不位移）、`.scopeButton` 的虚线→实线接受硬切、
  collections 的 `.rowActive` 边框未进过渡（会改行高）。
- **021** `mousemove` 合并到 rAF，`data-resizing` 改为 `onStart` 时设一次；
  `onResizeEnd` 里同步补写最后一帧后再移除属性。`ResizeHandle` 增 `onStart?`。
- **022** 六处全清。`grep cubic-bezier`（tokens.css 除外）、
  `grep "transition:.*border-width"` 均归零；`nameIn`/`traceIn`/`drawerIn` 三个
  克隆关键帧已删。**一处保守偏离**：`.radioOn` 保留了原有的
  `background: var(--stg-bg-input)`（与基态同值、删掉是安全的，但保留可保证声明
  集合不变）。构建产物核对：`slideInRight .22s` 现在有 2 处（供应商抽屉 + 文档格式
  抽屉，如期共用）。
- **023** 结论是**分支 A：不是缺陷**，未改任何组件代码。见「阻断 B」一节与
  `docs/issues/motion-enter-only-hidden-tab.md`。方案 017 已解锁为 TODO。
- **024** 删 1 行 + 删 1 个关键帧，原位留下「为什么没有入场」的注释。
- **025** 第 1 步落地；**第 2 步按判据 2 撤回**，撤回依据是实测而非判断——单张
  新挂载的卡片确实会跑 `fadeIn`（`freshOpacity: "0"`），而只有第 1 步时卡片身上
  零动画（`step1CardAnims: 0`）。读数抄在方案 025 里。

### ⚠ 目检时实测到的三处更正（2026-08-26，PR #334）

两条都是**方案里写错的推理**，不是代码写错。用 CDP 在可见页面里量出来的。

**一、020 的第 1 条判断理由是错的，而且盖住了一个真的 3px 位移。**
方案原文写「`.railRowOn` 的 3 + 15 = 18，内容位置完全不变」——只算对了 ON 那一
半。基态 `.railRow` 的 `border-left: 3px solid transparent` 已经占住那 3px，
未筛选时内容左沿是 **21px**，`padding-left: 15px` 是重复补偿，把它拉到 18px：

```
未筛选 21px   筛选中 18px   → 每次筛选行内文字横跳 3px
```

改动前就存在，但加了颜色过渡之后更显眼（颜色 120ms 渐变、文字瞬间跳）。
已删掉那行 `padding-left`，实测 21 → 21。

**二、021 的性能说法说重了。** `Performance.getMetrics` 的 A/B：同样 60 次宽度
变化，每次写 DOM 只产生 0–3 次 recalc/layout，不是 60 次——**浏览器本来就批处理**
样式失效与布局。合并到 rAF 仍是对的做法，但省下的是每帧多余的 1–2 次失效，
**不要指望肉眼可见的提速**。commit message 与 PR #332 描述已相应更正。

**三、022 的「逐像素一致」不准确。** 并排渲染新旧两种单选点、20 倍放大截图后
在图内切半比对：**几何完全一致**（外缘 0 / 环厚 4px / 中心留白 5px / 右缘 13），
但 1.92% 的像素有差异、最大通道差 64/255，全部落在环内缘的曲线上——边框圆角
与内阴影不是同一套抗锯齿光栅化。13px 实际尺寸下是亚像素级，肉眼不可见，
但严格说不是逐像素相同。

**目检已完成**（2026-08-26，作者在真 Tauri 窗口 + 真项目上跑过）。前三条
（020 的文字位移、021 的样式/布局计数、022 的单选点几何）已由 CDP 实测替代并
记在上面的「三处更正」里；剩下三条由作者手工确认通过：

1. **021** 真窗口拖拽 —— OK
2. **024** 边界处惯性滚动，「回到最新」气泡不重复浮起 —— OK
3. **025** 换取材范围整墙淡入、搜索打字零动画 —— OK

至此第五批（019–025）全部落地并验收完毕。每份方案的 Verification 一节保留了
具体步骤，以后回归照跑。

## 第六批（026–029，基准 1a72e2e）

来源与第四批同类：一次 `find-animation-opportunities` 勘察（找「该动而没动」的
地方）。勘察扫了全部动效接缝，**只提了 4 条**——前五批已经把明显的问题清干净，
剩下的都是新代码没接上既有约定，或既有约定只落实了一部分。

- **026**：**016 的漏网之鱼。** 那四张审批卡有三个挂载点（`AgentChat` /
  `AiPanel` / `RoleplayChat`），016 的 scope 写的是「1 个 CSS 文件，1 条新规则」，
  只覆盖了 `AgentChat`。另外两处至今一帧硬切。处方和理由 016 已定死，本方案逐字
  沿用，不重新论证。性质同 015（006 的漏网之鱼）、022（005 的漏网之鱼）。
  **杠杆最高，建议先做。**
- **027**：一致性检查跑完数秒后，N 张发现卡同时硬切出现。**本方案不做错峰**——
  起草时的错峰拟案已在立案阶段自我否决，理由写在方案正文里：`ignore()` 会把
  发现从 `openIssues` 移除，其后每张卡 `nth-child` 位次前移，任何基于位次的
  `animation-delay` 都会让并未重挂载的卡片集体重放。**与 025 第 2 步的撤回是同一
  个失败模式**，且触发器比 025 更主要（025 是搜索打字，此处是列表的主操作之一）。
- **028**：生成图等了 20–60 秒，data URL 一到直接弹出。全应用最稀有、情绪最高的
  一个瞬间，表现和报错弹窗没区别。**只覆盖生成结果的候选图**，不推广到头像/图库
  （频次不对，且知识库墙已有整墙 `fadeIn`，再叠一层会双重淡入）。
- **029**：提示词库的确认痕迹**有进场没退场**——淡入 240ms，然后计时器到点整行被
  切掉。该功能的设计意图是「不用 toast，就地出现、一秒半后消失」
  （`snippetTrace.ts:12-13`），而「消失」被实现成了「被切掉」。唯一一份要动
  TypeScript 的，也是唯一一份修**已有**动效缺陷的。

### 推荐执行顺序与依赖

1. **026**（3 个文件，但只是把 016 已定案的规则补到两处；杠杆最高）
2. **029**（唯一的 TS 改动；验证时务必跑「淡出途中被新痕迹打断」那条回归）
3. **027**（1 条 CSS 规则；验证时务必跑「忽略一条后幸存卡片不重放」那条回归）
4. **028**（1 行 CSS；需要开生图 Beta 开关 + 配好图像模型才能验证）

**四份互不依赖，改动文件零重叠**，可并行执行：

| 方案 | 触碰的文件 |
|---|---|
| 026 | `ai/AiPanel.module.css`、`ai/AiPanel.tsx`、`roleplay/RoleplayChat.module.css` |
| 027 | `ai/ConsistencyCheck.module.css` |
| 028 | `ai/ImageGenModal.module.css` |
| 029 | `ai/snippetTrace.ts`、`ai/SnippetPicker.module.css`、`ai/SnippetPicker.tsx` |

**均不新增 `global.css` 的关键帧，也不新增 Motion 预设。** 四份复用的 `dropIn`、
`slideUp`、`fadeIn`、`fadeOut` 都已存在；任何一份若打算新增关键帧，都说明理解偏了，
且会撞上方案 019 的 `cssKeyframeNames.test.ts`。

**唯一允许新增 `prefers-reduced-motion` 媒体查询的地方：没有。** 四份最终都不带
`animation-delay`（027 的错峰已撤），全局规则（`global.css:122-129`）足够。

### 勘察时明确**否掉**的候选（不要「顺手补上」）

- **`CommandPalette`** —— 键盘触发、100+/天。方案 014 的既定决策，design-system.md §247 已同步。
- **`AgentChat` 的「回到最新」气泡** —— 方案 024 刚**删掉**它的入场动画。不要加回来。
- **`AgentLog` 流式记录行** —— 方案 003 的既定结论。
- **`LoreWall` 卡片错峰** —— 方案 025 第 2 步已按实测判据撤回。
- **`FileTree` 展开/折叠** —— 100+/天的核心导航；chevron 本身已有 transition。
- **`ConfirmDialog` 改长按确认** —— 已是模态 + 焦点默认落在取消键，再加摩擦有害。
- **全局 `<img>` 淡入** —— 频次不对；028 因此只覆盖生成结果。

### 一处未解决的观察（不构成方案）

`global.css:122-129` 在 `prefers-reduced-motion` 下用 `!important` 把所有动画压到
`0.001ms`，即**归零而非变柔**。`src/lib/motion.ts` 的 `useMotionPreset` 在 JS 侧做的
是正确的那种降级（剥掉 transform、保留 opacity 淡入），CSS 侧没有对应物。

第六批四份都以 opacity 为主，归零对它们是可接受的降级，所以没有一份去对抗这条
全局规则。但**如果以后要加位移较大的 CSS 动效**，这个缺口会开始咬人——届时该讨论
的是全局策略，不是在单个组件里打补丁。

### 执行记录（2026-08-26，基准 1a72e2e）

026–029 已全部落地。改动 8 个源文件、72 行新增 / 14 行删除，四份方案的 Steps 逐条
照做，**无一处即兴发挥**——四份方案引用的所有 verbatim 摘录（含行号）都与工作树精确
吻合，执行者报告零 mismatch。

门禁：`pnpm exec tsc --noEmit` 无诊断 · `pnpm test` 190 文件 / 2563 用例全绿（含方案
019 的 `cssKeyframeNames.test.ts`，四份均未新增关键帧）· `pnpm build` 成功。

**按「阻断 A」的判据核验了构建产物**——这是本仓库唯一能在不跑应用的情况下证明动画
真的会播的检查：

```
$ grep -ohE "animation:[^;}]+" dist/assets/*.css | grep -cE "dropIn"          →  8（原 6 处 + 026 的 2 处）
                                                          "slideUp"           →  1（027）
                                                          "fadeIn (.32s|320ms)" →  1（028）
                                                          "fadeOut (.16s|160ms)" →  3（含 029）
带作用域后缀（_dropIn_<hash>_1 那种）的引用                                    →  0 处
```

**一条执行者报告需要更正的观察**：执行者称「`pnpm tsc --noEmit` 在 pnpm 11.12.0 上
会静默跑成 install 而不是 tsc，CLAUDE.md 记的调用方式是 no-op」。**该结论不成立。**
用一个故意写错类型的探针文件实测，两种调用形式都能捕获并以 exit 1 失败：

```
$ echo 'export const probe: number = "nope";' > src/__tsc_probe.ts
$ pnpm tsc --noEmit        →  src/__tsc_probe.ts(1,14): error TS2322 ... EXIT=1
$ pnpm exec tsc --noEmit   →  src/__tsc_probe.ts(1,14): error TS2322 ... EXIT=1
```

执行者那次看到的 install 输出是 pnpm 的一次性自动安装，与 tsc 是否运行无关。
**CLAUDE.md 的 `pnpm tsc --noEmit` 无需修改。**

**目检已完成**（2026-08-26，作者在真 Tauri 窗口里跑过 `pnpm tauri dev`）。三条最
关键的回归全部通过：

1. **026** —— 第一张审批卡还在等待时让运行再产生一张，确认**新那张**播动画、
   **已在场的那张不重播**（这是「挂 `> *` 而非容器」唯一能验出来的地方）。
2. **027** —— 在一份 5 条以上发现的报告里点第 2 条的「忽略」，确认其余卡片**只是
   向上补位、没有任何一张重新淡入或位移**。若看到重放，说明有人加回了基于位次的
   delay。
3. **029** —— 在痕迹**正在淡出**的那 160ms 里再触发一次存入，确认新痕迹立刻以全
   不透明淡入接管，不卡半透明、不闪烁、不叠行。

至此第六批（026–029）全部落地并验收完毕。每份方案的 Verification 一节保留了具体
步骤，以后回归照跑。

## 第七批（030，基准 5f9d25a）

来源不是审计,是一次 `find-animation-opportunities` 扫描:作者问「跳到最顶/最后
能不能加滚动动画」。**滚动动画被否掉**(CodeMirror 只渲染视口附近的行,跨全文的
原生平滑滚动会中途取消——`EditorScrollNav.tsx:60` 的注释就是踩过之后写的;何况
唯一能平滑滚完的距离恰恰是最不需要动画的那种)。扫描里活下来的是另一件事:

- **030**:`toEnd` 和 `toTop` 两颗按钮外观完全一样,`toEnd` 却额外把光标搬到文末
  并抢走焦点,而界面上没有一处说出这件事。`highlightActiveLine` 有,但被刻意调到
  4% alpha——写作时不打扰,代价是一次几千像素的瞬移之后也接不住视线。

**依赖**:无。与 012（插入落点闪烁）共用 `--color-mention-bg` 与 1.6s 的落点词汇,
但代码互不相干,012 已 DONE,不需要按顺序。

**一条执行时容易踩空的地方**(已写进方案的 Repo conventions):这次的样式**不能**
照 012 走 `EditorView.baseTheme`,必须照 `aiTargetExtension` 把类名传进来、样式留在
`CodeEditor.module.css`。原因是落点行同时是 `.cm-activeLine`,而后者的规则是
`.wrap :global(.cm-activeLine)`(0,2,0),baseTheme 注入的类只有 (0,1,0)——动画播放
期间还能靠 animation origin 压过去,但 **reduced-motion 那支的静态色带会被直接盖掉,
一片都看不见**,且不报任何错。

| 方案 | 触及文件 |
| --- | --- |
| 030 | 新建 `lib/editor/caretFlash.ts`、`editor/CodeEditor.tsx`、`editor/CodeEditor.module.css`、`editor/EditorScrollNav.tsx` |

### 030 执行记录（2026-08-29）

已落地，机械验证全过：`tsc --noEmit` 无错、`vitest run` 204 文件 / 2827 用例全绿、
`cssKeyframeNames.test.ts` 单独跑过（`caretLandFlash` 无重名）。

两条“静默失败”风险已用 lightningcss 编译产物**实测**而非推断确认（tsc 查不出来，
CSS Module 的类型是松散 record，拼错只会得到 `undefined`）：

```
caretFlash exported? -> true          # styles.caretFlash 确实解析得出
落点规则  ._4-Qu6q_wrap .cm-line._4-Qu6q_caretFlash   → (0,3,0)
活动行    ._4-Qu6q_wrap .cm-activeLine                 → (0,2,0)
@keyframes caretLandFlash             # 未被哈希（cssModules.animation:false），
                                      #   全局命名空间不变量成立
```

reduced-motion 块也已确认按 (0,3,0) 发出（`animation: none` + 静态
`background-color`）——这正是 012 没做、本方案特意补上的那一支。

**一处执行者的合理偏离**：方案说“接在 `.cm-activeLine` 规则之后”，但紧跟着的
`.cm-activeLineGutter` 是同一对，插中间会把它们拆开，故改为追到文末。方案本身已声明
“不靠书写顺序”，产物也证实了，无影响。

**尚未验证的**：Feel check 一组全部未跑（需要 `pnpm tauri dev` + 一份上千字的文档）。
尤其是三条：空行结尾的文档能否看到整行色带（选 `Decoration.line` 的全部理由）、
reduced-motion 下色带是否仍然出现、以及 **1.6s 的整行色带会不会太抢眼**——最后这条
是方案里明写的、唯一允许调整的值（1.6s → 1s），由作者目检后定。

## 第八批（031–040，基准 43b52e9）

来源是一轮完整的 `improve-animations` 审计（recon → 四个只读子代理并行审 8 类 →
逐条回到 `file:line` 复核）。前七批的结论依然成立：全库**零** `transition: all`、
**零** `ease-in`、**零** `scale(0)`、**零** Motion `x/y/scale` 简写，
`useMotionPreset()` 那条不变量在全部 6 个消费点都成立。**本批发现几乎全部落在
`5f9d25a` 之后新增的代码上**——新文件没接上既有约定，而不是既有约定错了。
与第五、六批是同一个模式。

| # | 方案 | 严重度 | 状态 |
| --- | --- | --- | --- |
| 031 | [侧栏折叠不再过渡 width](031-sidebar-collapse-no-transition.md) | HIGH | DONE |
| 032 | [「移到分类」浮层补入场与锚定](032-category-move-menu-entrance.md) | HIGH | DONE |
| 033 | [阅读模式入场：令牌回归 + 关键帧去重 + 挂对触发器](033-lore-read-entrance-token-and-trigger.md) | HIGH | DONE |
| 034 | [分屏滚动联动合并到 rAF](034-scrollsync-raf-coalesce.md) | MEDIUM | DONE |
| 035 | [两个同步 spinner 补 reduced-motion 豁免](035-sync-spinners-reduced-motion.md) | MEDIUM | DONE |
| 036 | [AgentLog 进度条改用 transform: scaleX](036-agentlog-progress-composite.md) | MEDIUM | DONE |
| 037 | [删除分类确认框补入场与按压](037-category-delete-modal-entrance.md) | MEDIUM | DONE |
| 038 | [扮演计时从 10Hz 降到 1Hz](038-roleplay-timer-rerender.md) | MEDIUM | DONE |
| 039 | [最近项目行补按压反馈](039-recent-projects-row-press.md) | MEDIUM | DONE |
| 040 | [两处一次性闪烁在重复触发时静默失效](040-one-shot-flash-retrigger.md) | LOW-MED | DONE |

**031 单独审阅**：它删掉一个用户看得见的动效（侧栏折叠过渡），是**产品决策**
而不只是代码，体例同方案 014，带一步 design-system.md 同步。

**033 是两条发现的合并**：手写 `cubic-bezier` + `readIn` 克隆（内聚回归），
与「入场挂错了触发器」（`R` 键重放整张纸滑入 / 换条目零动效且不重置滚动）。
它们改的是同一段三行 CSS，拆开会互相推翻。

### 推荐执行顺序与依赖

1. **032**（2 行 CSS，零风险，015 的漏网之鱼）
2. **031**（删 1 行 + 文档同步；杠杆最高，但含产品决策）
3. **033**（3 行 CSS + 1 个 `key`；让 022 的 `cubic-bezier` 不变量回到零）
4. **034**（**唯一有陷阱的一份**：`scrollSync.test.ts` 是同步断言的，
   rAF 必须做成可注入，否则会打挂 8 条断言）
5. **035 / 036 / 037 / 038 / 039**（互不依赖，可并行）
6. **040**（**必须在 033 之后**——两者都改 `LoreDetail.tsx`）

依赖关系：**033 → 040**（同一个 `LoreDetail.tsx`）。其余九份改动文件零重叠，
可并行执行：

| 方案 | 触碰的文件 |
|---|---|
| 031 | `layout/Sidebar.module.css`、`docs/reference/design-system.md` |
| 032 | `lore/CategoryMoveMenu.module.css` |
| 033 | `lore/LoreReadView.module.css`、`lore/LoreDetail.tsx` |
| 034 | `lib/editor/scrollSync.ts`、`lib/__tests__/scrollSync.test.ts` |
| 035 | `settings/panes/syncPane.module.css`、`lore/SyncPresence.module.css` |
| 036 | `ai/AgentLog.module.css`、`ai/AgentLog.tsx` |
| 037 | `lore/CategoryDeleteModal.module.css` |
| 038 | `roleplay/RoleplayChat.tsx` |
| 039 | `layout/RecentProjects.module.css` |
| 040 | `lib/editor/caretFlash.ts`、`lore/LoreDetail.tsx` |

**均不新增 `global.css` 的关键帧，也不新增 Motion 预设。** 各份复用的
`fadeIn`、`scaleIn`、`dropIn`、`spin` 都已存在；任何一份若打算新增关键帧，
都说明理解偏了，且会撞上方案 019 的 `cssKeyframeNames.test.ts`。
033 与 035 是**净删除**关键帧（`readIn` / `syncSpin` / `presenceSpin`），
019 的测试正好是它们的回归网。

### 本批未立案的 LOW 档（有据可查，日后可捡）

令牌与关键帧收敛批（`EASE_OUT` 手打三份且 `motion.ts:30` 未导出、
`DocFormat.module.css` 4 处裸 `ease`、2 处手写展开 `120ms var(--ease-out)`、
`writerPulse`≡`pulseDeep`、`modalPop` 与 `--ease-spring` 均零消费者、
`orderFlash 400ms` 超预算）；`LoreReadView` 未过渡的三处 hover 与
`.cover`/`.figure` 无按压；`.modeBtnActive` 的 3px 几何跳动；
`LoreReadView.module.css:21` 的死 reduced-motion 块（已由 033 顺带删除）；
`RecentProjects`/`ResizeHandle` 的 `width` 过渡。

### 审计时明确**否掉**的候选（不要「顺手补上」）

`@media (hover:hover)` 门（全库零处，但这是 Tauri 桌面应用，触摸假 hover 不是
真实故障模式）；`RecentProjects` 的 `height: auto` 折叠（稀有 + 惯用写法，
其 `initial={false}` 与 240/160 非对称都是对的）；**任何形式的错峰**
（方案 025/027 已两次按实测撤回）；`collections.module.css:277` 的
`border-left-color`（纯 paint，两态都是 3px，注释已说明）；
`App.tsx:50-75` 的拖拽（已 rAF 合并 + 补尾帧 + 抑制过渡，教科书级）。

### 审计路过发现的一处**非动效**缺陷（未立案，单独记录）

`src/components/lore/LoreReadView.tsx:530-546` 引用了十个在
`LoreReadView.module.css` 里**不存在**的类（`dictTable`、`dictHeadRow`、
`dictColSrc`、`dictColDst`、`dictColNote`、`dictSrc`、`dictDst`、`dictNote`、
`dictRow`、`dictRest`）。`grep` 确认全库只有 `.tsx` 侧的使用、没有任何定义，
于是每个都解析成 `undefined`，`dict: true` 条目的词典表渲染成无样式的堆叠
`<span>`。与动效无关，故不在本批范围内。

### 执行记录（2026-08-31，基准 43b52e9）

031–040 已全部落地。门禁：`pnpm exec tsc --noEmit` 无诊断 ·
`pnpm test` **218 文件 / 3150 用例全绿**（含方案 019 的 `cssKeyframeNames.test.ts`
——本批净删三个关键帧，它正是这次删除的回归网）· `pnpm build` 成功。

按「阻断 A」的判据核验了构建产物（本仓库唯一能在不跑应用的情况下证明动画真的会播）：

```
被删关键帧 readIn / syncSpin / presenceSpin 在产物中          →  全部不存在
带作用域后缀（_riseIn_<hash>_1 那种）的动画引用                →  0 处
riseIn 引用 4 → 5（032）· dropIn 8 → 8（未变，如方案要求）
spin 引用 +2（035 的两个 spinner 收敛回全局）
animation-duration:1.6s !important 的本地豁免  9 → 11 个文件（035 的两个）
transition 里仍带 width 的规则：只剩 RecentProjects / ResizeHandle 两处 LOW 档
  （侧栏那条 --transition-slow 的 width 已消失，031 生效）
.rowProgressFill → transform-origin:0; width:100%; transition:transform（036，
  与范本 .progressFill 的产物形状完全一致）
.menu（移到分类）→ animation:riseIn .14s var(--ease-out); transform-origin:0 100%
```

**一处方案自身的错误，执行时被发现并已更正（032）。** 初稿处方写的是
`dropIn`，理由只考虑了「原点在下」而没查关键帧的方向语义。执行者照方案办事
并在报告里提出疑问，经核实：`global.css:100` 的注释早就把规则定死了——
「下挂用 dropIn（从触发器落下），上挂用 riseIn」——而本菜单的锚点恒为
`above: true`（`LoreWall.tsx:1039` 是唯一调用点）。`dropIn` 会让菜单从 4px
上方**掉下来**，与它实际生长的方向相反。方案与代码均已改为 `riseIn`，
方案顶部留了修正记录。

**一处执行判断已收敛（033）。** 方案 Step 3 说「删掉整个 `@media` 块换成注释」，
而 Target 代码块画的是保留空壳、注释放在里面；执行者按 Target 办。最终采用
**裸注释、不留空 `@media` 壳**——留着空壳恰恰会造成注释本身警告的那种误读
（读者扫到一个媒体查询就以为此处已温和降级）。

**目检仍待作者**（需真 Tauri 窗口）。每份方案的 Verification 一节都写了具体步骤，
其中六条最关键的回归：

1. **031** 长文档 + 分屏下反复折叠侧栏，正文**一次到位**不再连续重排折行；
   Performance 面板该区间的 Layout 计数应从 ~19 降到个位数。
2. **032** 「移到分类」菜单必须**升起**而不是落下——看到它先在上方 4px 再下沉，
   说明有人改回了 `dropIn`。
3. **033** 按 `R` 切模式不再有整张纸滑入；滚到正文中段点「下一条」，
   新条目应**从顶部**开始并淡入。
4. **034** 触控板惯性滚动分屏跟随不得抖动或来回弹跳（弹跳＝`driver` 归属被挪错帧）。
5. **035** 开系统「减弱动态效果」后，两个同步指示器仍在转（慢一半），
   不再冻成静止残环。
6. **040** 1.6s 内**连按两次**「跳到结尾」，第二次也必须闪。

## 第九批（041–043，基准 43b52e9 + PR #430）

第八批把非 LOW 的十一条清完之后，作者要求继续处理 LOW 档。**不是新一轮审计**——
这三份就是第八批「本批未立案的 LOW 档」那一节列出的内容，逐条回到 `file:line`
复核仍然成立之后立的案（`033` 顺带删掉的那个死 reduced-motion 块已从清单移除）。

| # | 方案 | 严重度 | 状态 |
| --- | --- | --- | --- |
| 041 | [令牌归位与关键帧去重](041-token-and-keyframe-consolidation.md) | LOW | DONE |
| 042 | [阅读模式补齐悬停过渡与按压](042-lore-read-hover-press.md) | LOW | DONE |
| 043 | [阅读/管理切换器消除 3px 几何跳动](043-mode-switch-geometry.md) | LOW | DONE |

- **041** 体例同方案 022（005 的漏网之鱼），七处同一类修法：`--ease-out` 的控制点
  手打了三份（`motion.ts:30` 是 `const` 而非 `export const`，所以
  `RecentProjects.tsx:34` 只能再抄一遍）、全库仅有的四条裸 `ease`、两处把
  `--transition-fast` 手工展开、`writerPulse` ≡ `pulseDeep`、`orderFlash` 400ms
  超预算、`modalPop` 零消费者。
- **042** `LoreReadView` 三处悬停变色无过渡、目录主项比子项少一个悬停态、
  两个 `cursor: zoom-in` 入口零反馈。
- **043** `.modeBtnActive` 的 `border-left: 3px` + `font-weight: 500` 都改变固有
  宽度且都不在过渡列表里——背景礼貌地渐变，几何瞬间跳。**与方案 020 目检时在
  `.railRowOn` 抓到的是同一个失效模式**（见上面「三处更正」第一条）。

### 推荐执行顺序与依赖

**042 → 043**（都动 `lore/` 下的界面，但文件不同；顺序只是为了目检时一起看）。
**041 可与两者并行**——它是唯一动 TS 的一份，且改动文件与另两份零重叠。

| 方案 | 触碰的文件 |
|---|---|
| 041 | `lib/motion.ts`、`layout/RecentProjects.tsx`、`settings/panes/DocFormat.module.css`、`ai/SnippetPicker.module.css`、`roleplay/RoleplayChat.module.css`、`ai/WriterTurn.module.css`、`settings/panes/ProvidersModels.module.css` |
| 042 | `lore/LoreReadView.module.css` |
| 043 | `lore/LoreDetail.module.css` |

**041 是唯一会删关键帧的一份**（`writerPulse`），方案 019 的
`cssKeyframeNames.test.ts` 是它的回归网。

### 三条执行时最容易踩空的地方

1. **041 的 `140ms` 不要改成 `120ms`。** DocFormat 那三条的时长不是任何令牌，
   只换曲线（`140ms var(--ease-out)`）；只有 `:802` 的 `120ms ease` 恰好等于
   `--transition-fast`，整条换令牌。混为一谈会顺手改掉三处控件的节奏。
2. **041 不要删 `--ease-spring`。** 它确实零消费者，但它是 design-system.md
   记载的设计词汇，删它是**设计决策**不是清理。这与删 `modalPop` 不同——
   后者是一套与既有 CSS 模态语汇竞争的第二实现。
3. **043 不要用 `padding-left` 补偿几何。** 方案 020 的目检记录（「三处更正」
   第一条）证明那条路会算错，而且是**静默**错的。用基态透明边框占位。

### 执行记录（2026-08-31，基准 43b52e9 + PR #430）

041–043 已全部落地。门禁：`pnpm exec tsc --noEmit` 无诊断 ·
`pnpm test` 218 文件 / 3150 用例全绿（含 `cssKeyframeNames.test.ts`——041 删了
`writerPulse`）· `pnpm build` 成功。产物核验：

```
writerPulse 在产物中已不存在 · pulseDeep 引用 3 → 4
裸 ease（形如 "140ms ease"）                                 →  归零
--ease-out 的控制点                                          →  只剩 tokens.css:47 与 motion.ts:30
.modeBtn 基态  → border-left:3px solid #0000（占位，几何恒定）
.modeBtnActive → 只换 border-left-color + text-shadow，font-weight 保持 400
```

**一处方案自身的抄录错误，执行时被发现并已更正（042）。** §B 引的 `.tocItem`
代码块误抄成了 `.tocSub` 的值（`10px` / `--color-text-faint`，实际是 `11px` /
`--color-text-muted`，且还有 `gap`/`padding`/`border` 三条）。**结论不受影响**
——`.tocItem` 确实有基态规则、确实没有 `:hover`，而 Target 写的是「既有声明
不变」的纯追加。执行者照方案办事、发现不符后按判断继续而非停下，是对的：
方案 Boundaries 里「对不上就停」针对的是**处方所依赖的**代码发生漂移，
而这里漂移的是引文本身。方案顶部已留更正记录。

**目检待作者。** 043 的判据最明确、也最容易验出改坏：

- 反复点切换器（或按 `R`），盯住两个格子的**文字左沿**——必须**完全不动**。
  改动前每次切换都横跳几像素。可用 DevTools 对同一个 `.modeBtn` 读两态的
  `getBoundingClientRect().width`，两次应相等。
- 选中项的字仍应比未选中项重一点点。若看起来完全一样，把 `text-shadow` 的
  模糊值 0.4px 调到 0.5px；若发糊，调到 0.3px。**不要**改回 `font-weight`。
- 042：图库里按住一张图，只有**图片**缩、图注文字不动。

## 第十批（044–050，基准 484fe4b）

来源：2026-09-10 一次全应用 `review-animations`（判定 Block）→ 作者要求「全部问题」立案 →
`improve-animations` 逐条回到 `file:line` 复核、**并对照 001–043 的既有决策**。审查给出 21 条，
**立案 7 份（合并后覆盖 13 条），撤回 8 条**（撤回理由见下，均有据可查）。

与前几批不同，本批**两份是决策变更**（044、047），推翻的依据都是「事实在决策之后变了」，不是品味变了：

- **044** 推翻方案 004 的「不动 App.tsx 顶层视图切换」与侧栏标签的 enter-only 入场。004 定于 08-22；
  `677db8d`（08-24）才把 ⌘1‥⌘5 接上——⌘1/⌘2 切侧栏标签，⌘3/⌘4 切主视图。两处从鼠标动作变成了键盘高频动作。
- **047** 重开方案 009 的「全局一刀切保持不动」。第六批 README 已把它记为「一处未解决的观察」（归零而非变柔），
  此后 035 又补了两个 spinner 豁免，`ImageLightbox`（09-01）则已经漏掉——补丁模式在漏。

| # | 方案 | 严重度 | 状态 |
| --- | --- | --- | --- |
| 044 | [⌘1‥⌘5 触发的主视图与侧栏标签切换去动画（决策变更）](044-keyboard-screen-switch-instant.md) | HIGH | DONE（目检通过） |
| 045 | [知识库「条目 → 条目」不再推入推出](045-lore-detail-to-detail-no-push.md) | MEDIUM | DONE（目检通过） |
| 046 | [Motion 浮层退场收快（不对称时长）](046-motion-overlay-asymmetric-exit.md) | MEDIUM | DONE（目检通过） |
| 047 | [reduced-motion 全局兜底：去位移、留淡入（决策变更）](047-reduced-motion-drop-movement-keep-fades.md) | MEDIUM | DONE（目检通过） |
| 048 | [图片灯箱 spinner 补 reduced-motion 豁免（035 的漏网之鱼）](048-lightbox-spinner-reduced-motion.md) | MEDIUM | DONE（目检未复现加载态） |
| 049 | [令牌与节奏收敛（041 的漏网之鱼）](049-token-and-rhythm-consolidation.md) | LOW | DONE（目检通过，tabFlash 定 240ms） |
| 050 | [最后两处非合成层动效](050-last-non-composite-motion.md) | LOW | DONE（目检通过，A 保留） |

- **045** 与方案 033 的验收判据**直接矛盾**：033 要求「换条目只有 opacity 在变，不应有任何 X 方向位移」，
  而 `LoreWall.tsx` 的推进层 `key` 绑的是条目，每次换条目都是旧页右退、新页右进的反向交叉。修法只是把 `key` 从推进层挪到 `LoreDetail`。
- **046** 尊重方案 014 把 AiDrawer / SettingsPage 定为「低频、适用标准动画」的判断，**只改退场**：这三个 Motion 浮层是全库唯一
  出场与入场一样长的浮层（其余都是 160ms，`ModalShell.tsx:43`）。只动 `motion.ts` 的三个 `exit`。
- **049** 让 022/033 的「`tokens.css` 之外零手写 `cubic-bezier`」不变量回到零（当前 10 处，同一条设计稿曲线，给它令牌名 `--ease-settle`，**不改值**）。

### 推荐执行顺序与依赖

1. **048**（1 个文件，零风险，可随时做）
2. **044**（HIGH；决策变更，建议单独审阅、单独成 PR）
3. **045**（1 个文件；可与 044 并行）
4. **046**（**必须在 044 之后**——两者都改 `lib/motion.ts`，相邻行）
5. **049**（`tokens.css` + 重新生成 `contractData.ts`）
6. **047**（**必须在 049 之后**——同改 `tokens.css` / 生成文件 / `ContextMemory` / `Lab` / `AgentChat` / `design-system.md`；决策变更，建议单独审阅、单独成 PR）
7. **050**（与 047 同改 `AgentChat.module.css`；两者都已写成「谁先谁后都成立」，但顺序执行更省事）

| 方案 | 触碰的文件 |
|---|---|
| 044 | `App.tsx`、`layout/Sidebar.tsx`、`lib/motion.ts`、`docs/reference/design-system.md` |
| 045 | `lore/LoreWall.tsx` |
| 046 | `lib/motion.ts` |
| 047 | `styles/tokens.css`、`lib/theme/contractData.ts`（生成）、`styles/global.css`、`settings/panes/ContextMemory.module.css`、`settings/panes/Lab.module.css`、`ai/SnippetPicker.module.css`、`roleplay/SceneTransition.module.css`、`settings/panes/ProvidersModels.module.css`、`ai/AiPanel.module.css`、`lore/ai/LoreRunProgress.module.css`、`ai/WriterTurn.module.css`、`ai/AgentChat.module.css`、`lore/LoreReadView.module.css`、`lib/__tests__/cssKeyframeNames.test.ts`、`docs/reference/design-system.md` |
| 048 | `common/ImageLightbox.module.css` |
| 049 | `styles/tokens.css`、`lib/theme/contractData.ts`（生成）、`settings/SettingsPage.module.css`、`settings/panes/ModelDrawer.module.css`、`settings/panes/Lab.module.css`、`settings/panes/ContextMemory.module.css`、`common/Slider.module.css`、`lore/CategoryMoveMenu.module.css`、`ai/ChatMark.module.css`、`ai/SessionTabs.module.css`、`ai/AgentChat.module.css`、`docs/reference/design-system.md` |
| 050 | `layout/ResizeHandle.module.css`、`ai/AgentChat.module.css` |

**本批不新增、不删除任何 `@keyframes`**（047 与 050 只改关键帧体），也不新增 Motion 预设（044 净删 `viewSlide`）。

### 三条执行时最容易踩空的地方

1. **044 不要删 `key`。** 去掉的是动效，不是「换视图 / 换标签 = 整棵子树重挂」的语义。回到编辑器时仍有 160ms 窗格淡入（方案 011）、
   进知识库时仍有 200ms 整墙淡入（方案 025）——都是既定决策，**不是遗漏**。
2. **049 不要把 `cubic-bezier(0.2, 0.8, 0.2, 1)` 换成 `--ease-out`。** 它是设计稿给的值（`design-system.md:378` 原文），
   换掉就是改设计。本方案只起名字，不改值。
3. **047 改完 `tokens.css` 必须跑 `node scripts/gen-theme-contract.ts`**，不要手改 `contractData.ts`；且第 10 步的**反向验证**不能省——
   新测试若从未红过，就证明不了它守得住。

### 撤回的 8 条（不要「顺手补上」）

- **`CommandPalette` 的 80ms 遮罩淡入** —— 方案 014 的既定决策，design-system.md:396 原文「deliberately zero-animation (except an 80ms scrim fade-in)」。
- **`AiPanel` 任务切换删动效** —— enter-only 是 `AiPanel.tsx:1417-1425` 注释 + 方案 004 / 017 / 023 反复确认的既定模式；
  `springPanel` 约 0.25s 落定，在预算内；且只有鼠标入口。
- **`EditorArea` 窗格 `fadeIn` 删除** —— 方案 011 的加法项；审查指出的「与主视图滑动叠播」随 044 删掉滑动自然消失。
- **`@media (hover: hover)` 门** —— 第八批已否（Tauri 桌面应用，触摸假 hover 不是真实故障模式）。
- **一致性检查结果错峰** —— 方案 027 已按实测撤回（`ignore()` 让位次前移，基于位次的 delay 会集体重放）。
- **`AiDrawer` 键盘开关不动画** —— 方案 014 已把抽屉定为低频表面；本批只收快它的退场（046）。
- **`RecentProjects` `.pinBtn` 的 `width` 过渡**（第八批 LOW 清单里的一条）—— 唯一的合成层替代写法是把按钮浮在行尾，
  而它会盖住路径的**尾部**（文件夹名本身，`RecentProjects.module.css:161-163` 刻意保留的那一段）。行宽让位就是设计，代价是一行文字 120ms 的重排，**不值得**。
- **`Slider` 吸附时的 `left` / `width` 70ms** —— 14px 绝对定位元素、70ms、仅在松手吸附时发生；改成 transform 需要按像素测量轨道宽度，杠杆接近零。
  （它的曲线仍由 049 收进令牌。）

另有两处**只改注释、不改行为**的，已并入 049：`AgentChat` 排队圈在减动效下停转是对的（009：只恢复首要工作信号），注释写反了；
`SessionTabs` 的 `tabFlash` 注释写 120ms、代码 240ms。

### 该动而没动（本轮只发现一处，未立案）

- `settings/panes/DocFormat.module.css:1282` —— 窄屏（≤720px）下纸样的展开钮 `.previewChevronOpen { transform: rotate(180deg); }`
  没有 `transition`，一帧翻转；全应用其余 8 处展开 chevron（`Select`、`FileTree`、`settingsUi`、`Prompts`、`ProvidersModels`、`ModelDrawer`、`LoreImproveModal`、`LoreRunProgress`）都是 120–200ms。
  修法是给 `DocFormatPane.tsx:230` 的 `ChevronDown` 基态加 `transition: transform var(--transition-fast)`。量太小，未单独成方案。

### 已知的后续清理（不在任何方案范围内）

- 047 落地后，12 个模块里 spinner 豁免块头上的注释「压过 global.css 的一刀切兜底」会变得不准确（块本身仍正确：从「复活」变成「减速」）。
- `global.css` 的 `.cursor-blink` 全库零消费者（死类）。

### 执行记录（2026-09-10，基准 484fe4b）

七份按推荐顺序全部落地：048 → 044 → 045 → 046 → 049 → 047 → 050。未提交。

门禁：`node_modules/.bin/tsc --noEmit` 无诊断（直跑二进制，绕开 pnpm 的安装摘要）·
`pnpm test` **284 文件 / 4191 用例全绿**（含 `themeContract.test.ts` 与 `cssKeyframeNames.test.ts` 的新断言）· `pnpm build` 成功。

**047 的反向验证已做**：临时把 `slideUp` 改回写死的 `6px`，新断言如实报出 `slideUp — src/styles/global.css`；已还原。

产物核验（`dist/assets/*.css`）：

```
var(--motion-shift)                    → 13（方案预期 13）
--motion-shift:0（减动效声明）          → 1
animation-duration:.001ms              → 0（一刀切的 animation 部分已消失）
transition-duration:.001ms             → 1（保留，如方案要求）
var(--ease-settle)                     → 10；字面 cubic-bezier(.2,.8,.2,1) 只剩令牌声明 1 处
animation-duration:1.6s!important      → 12（048 +1）
@keyframes shimmer                     → {0%{transform:translate(-100%)}to{transform:translate(100%)}}
带作用域后缀的动画引用                    → 0
```

**浏览器实测**（worktree 的 `simple-ai-writer-worktree` dev server，已确认服务的是本 worktree 的文件；预览面板本身报告 `prefers-reduced-motion: reduce` 为真）：

- 047：同步探针（手动把 `currentTime` 拨到 0 读计算样式，不依赖 rAF）——
  减动效下 `dropIn` / `riseIn` / `slideInRight` / `scaleIn` 首帧一律 `matrix(1,0,0,1,0,0)`、`opacity 0`（位移没了、淡入还在）；
  把 `--motion-shift` 强制设回 1 后分别是 `matrix(0.98,0,0,0.98,0,-4)` / `(…,0,4)` / `(1,0,0,1,24,0)` / `matrix(0.96,…)`——**与改动前的写死数值逐一相同**。
- 046：设置页退场读到一条 WAAPI 动画，`duration 160`、只有 `opacity`（transform 被减动效剥掉）——证实 variant 级 `transition` 压过组件 prop。
  另查了 `motion-dom@13.1.1` 源码 `animation/interfaces/visual-element-target.mjs:23-27`：variant 自带的 `transition` 优先于 `getDefaultTransition()`。

**执行中的一处更正**：`global.css` 新写的注释里有一句 `` `animation: none` ``，被方案 019 的悬空引用守卫当成关键帧引用——
**它连 CSS 注释一起扫**，于是报出 `in` / `their` / `own` / `modules` … 八个「悬空名字」。已改写注释（不再出现 animation 加冒号），并在注释里写明原因。
以后在任何 `.css` 注释里写 `animation:` 都会撞上这条，这是守卫的已知盲区，不是缺陷。

**两处与方案判据的出入**（均不影响行为）：
- 044 的判据「`grep -rn viewSlide src` 必须为空」命中 1 处：`App.tsx` 新注释里解释「为什么删」时提到了 `viewSlide`。
- 050 的 A 步已落地，但判据（125% / 150% 缩放下 2px 线是否发虚）需要真窗口，未测。

**没能验证的**：
- 抽屉的 200ms 退场。预览面板在这一段被节流：600ms 内 rAF 不触发、`document.timeline` 不前进（尽管 `visibilityState` 报 `visible`），
  抽屉与设置页的 Motion 退场都卡在 DOM 里——与 `docs/issues/motion-enter-only-hidden-tab.md` 记录的是同一个测量陷阱，不是本批改坏的。

**目检清单（待作者，真 Tauri 窗口）**：

1. **044** ⌘1 / ⌘2 连按，侧栏一帧到位；⌘1 ↔ ⌘3 ↔ ⌘4 无横滑、无叠影（011 的窗格淡入、025 的整墙淡入仍在，属预期）。
2. **045** 详情里连点「下一条」零位移；**在 A 进编辑态后跳到 B，B 必须是全新状态**；网格 ↔ 详情推进不变。
3. **046** ⌘J 开抽屉（弹簧不变），Esc 关明显利落；关到一半再 ⌘J 从当前位置折返。
4. **047** 打开系统「减弱动态效果」：模态、下拉、供应商抽屉只淡不滑；spinner 半速仍转；脉冲点与闪烁光标静止。有 Mac 的话在 WKWebView 上确认普通模式下拉仍有 4px 下落。
5. **049** 设置页各处折叠 / 标签 / 滑杆吸附手感与改动前一致；`SessionTabs` 的 120ms vs 240ms 二选一。
6. **050** 分隔柄悬停线在 125% / 150% 缩放下不发虚（发虚就按方案第 3 步撤回 A）；对话图片占位扫光开 Paint flashing 不再持续闪绿。

### 目检结果（2026-09-10，PR #575 合入之后，作者在真 Tauri 窗口里跑过）

| 方案 | 结果 |
| --- | --- |
| 044 | 通过 |
| 045 | 通过（含「A 进编辑态后跳到 B，B 是全新状态」那条回归） |
| 046 | 通过（补上了预览面板里读不到的抽屉退场） |
| 047 | 通过 |
| 048 | **未复现**：灯箱加载态一闪而过，没能看到 spinner。改动与方案 035 的豁免块逐字同形，风险低；遇到再按方案 Verification 验 |
| 049 | 通过；`SessionTabs` 的 `tabFlash` **定为 240ms**（不改回设计稿的 120ms），注释已改为记录该决定 |
| 050 | 通过；A（分隔柄 `scaleX`）不发虚，保留，不撤回 |

至此第十批（044–050）落地并验收完毕，仅 048 的加载态留待偶遇时补验。

---

## 第十一批（051–054，基准 485de63）

本批来自一次全仓动效复审（`review-animations` → `improve-animations`）。复审的结论是**底子很稳**：
全库没有 `transition: all`、没有 `ease-in`、没有 `scale(0)`、没有超 320ms 的 UI 动效、没有键盘触发的动画；
19 处浮层的 `transform-origin` 全部锚在触发器上；17 个含无限动画的模块**全部**带本地 `prefers-reduced-motion` 块。
立案的四条都是**收口**，不是返工。

| # | 方案 | 严重度 | 状态 |
| --- | --- | --- | --- |
| 051 | [两处 JS 平滑滚动绕过了 reduced-motion](051-smooth-scroll-reduced-motion.md) | MEDIUM | DONE（目检待作者）|
| 052 | [滑杆吸附仍在动 left/width（050 的漏网）](052-slider-snap-composite.md) | LOW | DONE（像素等价已实测）|
| 053 | [标签闪线改走合成层（box-shadow → 伪元素 scaleY）](053-tabflash-composite.md) | LOW | DONE（目检待作者）|
| 054 | [App.tsx 一段注释仍在描述 031 删掉的 320ms 过渡](054-stale-sidebar-transition-comment.md) | LOW | DONE |

### 推荐执行顺序与依赖

**四份互不依赖，改的文件两两不相交**，可以任意顺序、也可以并行：

| 方案 | 触及文件 |
| --- | --- |
| 051 | `roleplay/RoleplayChat.tsx`、`settings/panes/ContextMemoryPane.tsx` |
| 052 | `common/Slider.module.css`、`common/Slider.tsx` |
| 053 | `ai/SessionTabs.module.css` |
| 054 | `App.tsx`（仅注释） |

建议按 **051 → 053 → 052 → 054** 走：051 是唯一有真实用户影响的一条（无障碍）；
053 收掉全库最后一个非合成层关键帧；052 需要逐像素比对，放在手上有闲心的时候做；054 是三行注释。

051 与 054 可以合进同一个 PR（都不改 CSS）；052 与 053 各自的目检判据不同，建议分开提交以便回退。

### 两处「重新翻案」已按既定决策撤回

复审最初还提了两条，核对方案记录后**撤回**，不立案：

1. **删掉零消费者的 `--ease-spring`**（`tokens.css:76`）—— 方案 041 的 Boundaries（`:155`）与方案 049 的
   Boundaries（`:198`、`:218`）**两次**明文记过：「它确实零消费者，但它是 design-system.md 记载的设计词汇，
   删它是设计决策不是清理。」本 README 第九批「不要删」一条（`:612`）同样在案。**保留。**
2. **删掉已成空操作的 `:global([data-resizing]) .sidebar { transition: none; }`** —— 方案 031 在
   「Repo conventions to follow」里已经承认它是空操作，并明确决定留着（它表达另一条不变量，方案 001 的
   Verification 还在引用它）。**保留。** 031 留下的真正遗留只有 `App.tsx` 那段过期注释，即方案 054。

### 需要回填的一处旧记录

方案 052 落地后，**方案 050 的标题「最后两处非合成层动效」与第八批「transition 里仍带 width 的规则：
只剩 RecentProjects / ResizeHandle 两处」这两句盘点都需要补一句**：当时漏了 `Slider.module.css:62-63`
（彼时写的是字面 `cubic-bezier`、且带 `.snapping` 前缀，两次 grep 都没捞到），由方案 052 补齐。

### 执行记录（2026-09-12，基准 485de63）

四份一次落地。门禁：`node_modules/.bin/tsc --noEmit` 无诊断 · `pnpm test` **287 文件 / 4241 用例全绿**
（含 `cssKeyframeNames.test.ts`）· `pnpm build` 成功。

机械判据逐条核过：

```
051  显式 behavior:"smooth" 的字面命中  → 只剩 EditorScrollNav.tsx:61 的注释（方案已声明豁免）
052  Slider 里 transition 带布局属性     → 空
052  全库 transition 带布局属性          → 只剩 RecentProjects:195（050 已明文撤回）
                                          + collections:311（border-left-color，是颜色，误命中）
052  Slider.tsx 内联 left                → 只剩刻度那一行
053  SessionTabs 的 box-shadow           → 空
053  全库关键帧里的 box-shadow           → 空（至此没有非合成层关键帧了）
054  "320ms collapse transition"         → 空；Sidebar 的 [data-resizing] 规则原样保留
```

**浏览器实测**（worktree 的 `simple-ai-writer-worktree` dev server，已确认服务的是本 worktree 的文件
——`Slider.module.css` 读得到 `--track-w`）：

- **052 的像素等价已坐实**。设置 → 上下文与记忆的三个滑杆，实测轨道宽 **260px**（= `--slider-w` 276 − 16，
  与文件头 anatomy 一致），拇指与填充条的几何：

  | pct | 拇指偏移（实测） | 旧公式 | 填充宽（实测） | 旧公式 |
  | --- | --- | --- | --- | --- |
  | 0 | −7.00 | `calc(0% − 7px)` = −7 | 0 | 0 |
  | 2.5 | −0.50 | `calc(2.5% − 7px)` = −0.5 | 6.5 | 260×0.025 = 6.5 |
  | 100 | 253.00 | `calc(100% − 7px)` = 253 | 260 | 260×1 = 260 |

  2.5% 这一档是键盘走出来的非整数值，比方案里预设的 50% 更能说明公式线性等价。
- **052 的过渡属性**：吸附态实测为 `transform 70ms var(--ease-settle), background …` 与
  `transform 70ms var(--ease-settle)`，`left`/`width` 已不在其中。
- **053 的减动效契约已坐实**（同步探针，不依赖 rAF）：`tabFlash` 的 50% 帧在
  `--motion-shift: 1` 下计算为 `matrix(1,0,0,2,0,0)`（= `scaleY(2)`，与改动前的 2px→4px 等价），
  在 `--motion-shift: 0` 下为 `matrix(1,0,0,1,0,0)`（= `scaleY(1)`，粗细不再变，只剩颜色那一档）。
  这正是方案 047 的契约，也是相对改动前的行为改进。
- 控制台无任何错误。

**仍待作者在真窗口目检**（都要项目/系统设置，预览面板给不了）：

1. **051** 打开系统「减弱动态效果」后：设置 → 上下文与记忆点「硬上限」指路应一帧到位；扮演对话用回退条跳轮同样一帧到位。关掉减动效则两处都应与改动前一样平滑。
2. **053** AI 面板会话标签条：当前标签顶部那条 2px 赭线仍在、切换标签跟着走；已有空标签时按「新会话」，顶线闪一次的观感与改动前相同；标签最上沿 1–2px 处点击仍能切换会话（验 `pointer-events: none`）。
3. **052** 三个滑杆的吸附手感、拖拽跟手、焦点环与禁用态。
