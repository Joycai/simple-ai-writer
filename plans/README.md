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

**仍未做的目检**（需要真窗口 + 真项目，代码验证覆盖不到）：020 的悬停手感与
「文字一像素都不许动」、021 的 Performance 面板一帧一次 Layout、022 的单选点
逐像素比对、024 的边界处来回蹭不闪烁、025 的换范围整墙淡入 / 打字零动画。
每份方案的 Verification 一节列了具体步骤。
