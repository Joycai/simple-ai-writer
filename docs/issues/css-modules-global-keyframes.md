# 模块 CSS 引用全局 keyframes 会悬空 —— 大部分 CSS 入场动画从未播放

> **状态：已确认（实测），未修复。** 本文记录的是一个**全应用范围**的静默缺陷：
> `.module.css` 里凡是 `animation: fadeIn / scaleIn / dropIn / riseIn / slideUp /
> slideInRight …` 这种引用 `global.css` keyframes 的声明，动画名会被 CSS Modules
> 哈希化（`fadeIn` → `_fadeIn_<hash>_1`），而 keyframes 本身留在 global.css 里、
> 名字没变 —— 引用悬空，**动画一帧都没播过**。没有任何报错：computed style 照样
> 报出（哈希后的）动画名，只有 `element.getAnimations()` 是空的。
>
> 发现于 2026-08-23 的动画审查（motion-review PR）：给供应商抽屉补退场动画时，
> 实测发现它的入场动画也从来没动过。

## 证据（Vite dev server 实测）

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

## 影响面

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

## 候选修法（未决策）

1. **切到 LightningCSS**：`vite.config.ts` 里 `css: { transformer: "lightningcss",
   lightningcss: { cssModules: { animation: false } } }` —— 一处配置让 40+ 处全部
   复活，且以后新写的代码不会再踩。代价：整条 CSS 管线换实现，需要一轮全面的
   视觉回归（对本项目主要是确认嵌套/前缀/取值序列化无差异）。
2. **每个模块重新声明它用到的 keyframes**：已在 `ProvidersModels.module.css` 里
   做了一份（见文件头部注释），可当范本。机械、安全、无管线风险，代价是
   40+ 处小重复，且新代码还会踩坑。
3. **改用全局工具类**（`.modal-closing` 模式）：动画挂在 global.css 的全局类上，
   组件按状态挂类。适合退场这种"状态类"，不适合 mount 即播的入场。

倾向 1（根治 + 防再犯），但要配一次真机全量目检 —— 40 多个从未播过的入场动画
一起苏醒，本身就是一次视觉变更。

## 修完之后

- 删掉本文档或把状态改为已修复，并把 `ProvidersModels.module.css` 里的
  模块内 keyframes 副本换回全局引用（若选修法 1）。
- global.css 的 "Reusable entrance animations" 注释要改口：在修复落地前，
  那些 keyframes 实际上只服务于 global.css 自己的全局类。
