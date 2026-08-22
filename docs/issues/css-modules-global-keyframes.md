# 模块 CSS 引用全局 keyframes 会悬空 —— 大部分 CSS 入场动画从未播放

> **状态：已修复（2026-08-23，切换 LightningCSS）。** 本文记录的是一个曾经
> **全应用范围**的静默缺陷：`.module.css` 里凡是 `animation: fadeIn / scaleIn /
> dropIn / riseIn / slideUp / slideInRight …` 这种引用 `global.css` keyframes 的
> 声明，动画名会被 CSS Modules 哈希化（`fadeIn` → `_fadeIn_<hash>_1`），而
> keyframes 本身留在 global.css 里、名字没变 —— 引用悬空，**动画一帧都没播过**。
> 没有任何报错：computed style 照样报出（哈希后的）动画名，只有
> `element.getAnimations()` 是空的。
>
> 发现于 2026-08-23 的动画审查（motion-review PR）：给供应商抽屉补退场动画时，
> 实测发现它的入场动画也从来没动过。

## 证据（Vite dev server 实测，修复前）

1. 打开 设置 → 供应商与模型 → 添加供应商，抽屉挂载后立即采样：
   - `getComputedStyle(drawer).animationName` → `_slideInRight_1tyu1_1`（模块哈希名）
   - 遍历 `document.styleSheets` 找 `CSSRule.KEYFRAMES_RULE` → 只有 `slideInRight`
     等**原名**（来自 global.css），没有任何哈希名的 keyframes
   - `drawer.getAnimations()` → `[]` —— 名字对不上，浏览器根本没创建动画
2. 在模块内**重新声明**同名 keyframes 后重测：`getAnimations()` 返回
   `[{ name: "_slideInRight_…", playState: "running" }]` —— 声明与引用一起被
   哈希，动画立刻活了。这就是修法有效性的对照组。

机制：Vite 默认走 postcss-modules，`postcss-modules-local-by-default` 会把
`animation` / `animation-name` 里的自定义标识符一并本地化，不管同文件里有没有
对应的 `@keyframes` 声明。`:global(fadeIn)` 写在 animation 值里不是合法语法
（postcss 直接报 "Double colon" 解析错误），此路不通。

## 影响面（修复前）

`grep -rn "animation:\s*(fadeIn|scaleIn|slideUp|slideInRight|dropIn|riseIn|pulse|pulseDeep|blink|spin|fadeOut|scaleOut)" src/components src/lib --include="*.module.css"`
当时命中 **40+ 处**，全部失效。包括：所有模态的 fadeIn/scaleIn 入场
（ConfirmDialog、LoreGenerator、LoreSplitModal、BatchRunModal、ImageGenModal、
PromptViewer、FacetEditModal、Onboarding、ErrorBoundary、sync…）、所有触发器弹层
（ContextMenu、Select、ModelSelector、AiDrawer 菜单、ReasoningControls）、以及
spin/pulse/blink 一类的**运行指示动画**（AgentLog、AiPanel、ConsistencyCheck、
LoreRunProgress、RoleplayChat 的 spinner 和呼吸点 —— 这些是"正在运行"的唯一
视觉信号，失效意味着 spinner 是静止的）。

**没有失效**的：keyframes 声明在同一个模块里的（AgentChat 的 shimmer、
SceneTransition 的 transitionGrow）、global.css 全局类走全局 keyframes 的
（`.modal-closing`、`.cursor-blink`、`.lore-cite`），以及所有 Motion/CSS
transition 驱动的动画 —— 这也是为什么这个缺陷能一直没被注意到：模态的
**退场**（modal-closing，全局类）一直在动，入场不动反而像"打开很快"。

## 采用的修法：LightningCSS + `cssModules.animation: false`

`vite.config.ts` 里一处配置：

```ts
css: {
  transformer: "lightningcss",
  lightningcss: {
    cssModules: { animation: false },
  },
},
```

40+ 处引用全部复活，且以后新写的模块 CSS 不会再踩。选它而不是「每模块重声明
keyframes」（机械、40+ 处重复、新代码照踩）或「全局工具类」（只适合退场那种
状态类）的理由和落地时的核查：

- **零新增依赖**：Vite 8 把 `lightningcss` 列为直接依赖（`^1.32.0`），
  `css.transformer: "lightningcss"` 是稳定 API。
- **`animation: false` 的语义**是「`@keyframes` 与 `animation(-name)` 都不再
  哈希」——代价是**模块内 keyframes 与 global.css 共用一个全局命名空间**。
  落地时全库只有三个模块内 keyframes（AgentChat 的 `shimmer`、SceneTransition
  的 `transitionGrow`、ProvidersModels 的 `slideOutRight`），与 global.css 的
  12 个名字零冲突。**以后在模块里写 `@keyframes` 要起全局唯一的名字**
  （vite.config.ts 的注释也记了这条）。
- 其余 CSS Modules 特性核查过兼容：全部 `composes` 都是同文件的（LightningCSS
  支持），`:global(...)` 选择器、`@container` 均正常；没有 grid 命名区域 /
  `@property` / `counter-style` 这类会被 custom-ident 哈希波及的用法。
- 类名哈希格式从 postcss 的 `_local_hash_n` 变为 LightningCSS 的
  `hash_local`（如 `RD2o8G_panel`）——纯运行时映射，没有代码依赖类名形状。

## 修复验证（2026-08-23，Vite dev server 实测）

对编译后的模块做端到端采样（动态导入模块 CSS 拿哈希类名 → 挂载元素 →
`getAnimations()`）：

- ConfirmDialog `.panel`（scaleIn）→ `[{ name: "scaleIn", playState: "running" }]`
- Select `.menu`（dropIn）→ `[{ name: "dropIn", playState: "running" }]`
- AgentLog `.markerSpinner`（spin）→ `[{ name: "spin", playState: "running" }]`

真实交互：打开设置页后 `document.getAnimations()` 报出 `fadeIn` + `scaleIn`
在播（修复前为空）。构建产物抽查：`dist/assets/*.css` 里 animation 引用与
`@keyframes` 声明都保持原名。`pnpm exec tsc --noEmit`、`pnpm test`（2070 通过）、
`pnpm build` 全绿，dev 控制台与 server 日志无 CSS 相关报错。

**未做**：全量真机目检。40+ 个从未播过的入场动画一起苏醒，本身就是一次视觉
变更 —— 需要一轮真机走查确认没有哪处入场动画在如今的布局里显得突兀。

## 收尾（随修复一并完成）

- `claude/motion-review-fixes`（PR #284）曾在 `ProvidersModels.module.css` 头部
  重声明过 `fadeIn` / `slideInRight` / `fadeOut` 作为局部修法（当时的对照组）。
  LightningCSS 下它们不再被哈希、与 global.css 同名共存，副本冗余——合并 main
  时已删掉，改回引用全局 keyframes。该模块自己的 `slideOutRight`（global.css
  没有的退场 keyframes）保留在模块内。
