# enter-only 的 keyed `motion.div` 「在 reduced-motion 下停在 initial」—— 是测量产物，不是缺陷

> **状态：已澄清（非缺陷），2026-08-26。** 本文记录的是一次**误报的归因**，以及
> 它暴露出的一个会反复咬人的测量陷阱。代码没有改动——`Sidebar.tsx` 与
> `AiPanel.tsx` 的 enter-only 模式在减动效下工作正常，实测见下。

## 报告

`plans/README.md`「阻断 B」（2026-08-23，基准 36eda7b）记：开着 Reduced Motion 跑
起来，侧栏面板内容永久停在 `opacity: 0`，切换「文件/大纲」标签、等 1.2s 之后依旧
是 0。当时的结论是「方案 004 引入的 enter-only 模式（keyed `motion.div` +
`initial`/`animate`，无 `AnimatePresence`）在 `MotionConfig reducedMotion="user"`
下不会推进到 `animate`」，并据此把方案 017 回退、标记 BLOCKED。

测到的读数是：

```
_contentFlush_1wdy8_102  →  computedOpacity "0"   239×672
                            inline: "opacity: 0; transform: translateY(6px);"
```

## 为什么这个归因立不住

**内联样式里 `transform: translateY(6px)` 还在。** 而
`useMotionPreset()`（`src/lib/motion.ts:41-54`）在减动效下的**唯一职责**就是把
`transform` 从每个 variant 里剥掉，两处 enter-only 表面都调用了它
（`Sidebar.tsx:86`、`AiPanel.tsx:1359`）。若减动效那条路径当时真的生效了，这串
内联样式不可能存在。也就是说：那次读数里 Motion 根本没走到减动效分支，
「reduced-motion 导致停在 initial」是没有证据支撑的。

真正的解释在两天后（2026-08-25）被独立坐实：**浏览器预览面板的标签页
`document.visibilityState === 'hidden'`，rAF 不派发、动画时间轴根本不推进。**
在这样一个标签页里，任何 `motion.div` 都会永久停在它的 `initial` 值上——
`opacity: 0` 加 `transform: translateY(6px)`，一字不差就是上面那串。同一棵树里被
`AnimatePresence` 包着的 `fillLayer` 收敛到了 `opacity: 1`，也与此相容：它们在页面
转入隐藏之前就已经跑完了。

## 实测（2026-08-26，基准 93eb7de + 本轮 019–022 的改动）

在一个**可见**的页面里重测。方法：`pnpm dev` 起 1420，Chrome
`--headless=new --remote-debugging-port=9333` 直连，CDP
`Emulation.setEmulatedMedia` 切减动效，用 Web Animations API 读状态
（**不看截图、不用 `setTimeout` 采样、不读过渡中途的 `getComputedStyle`**——
这三样在隐藏标签页里都会说谎）。

```
── 基线（不开减动效）──
{ "cls": "_3BSeBa_contentFlush", "visibility": "visible", "reduced": false,
  "animCount": 0, "before": { "inline": "opacity: 1; transform: translateY(0px);",
                              "opacity": "1" } }

── 开减动效后 reload ──
{ "cls": "_3BSeBa_contentFlush", "visibility": "visible", "reduced": true,
  "animCount": 0, "before": { "inline": "opacity: 1;", "opacity": "1" } }
```

两件事同时得到证实：

1. **减动效下内联样式里没有 `transform`** —— `useMotionPreset()` 确实剥掉了它，
   `useReducedMotion()` 确实返回 `true`（`reduced: true`）。
2. **两种模式下 `opacity` 都收敛到 `1`** —— 元素可见，没有停在 `initial`。

`animCount: 0` 是因为读的时候动画已经跑完并被清理，不是「没有动画」——基线那组
的 `transform: translateY(0px)` 是终态，若动画从未推进，它会是 `translateY(6px)`。

> **`key` 变化的情形不需要单独测。** React 的 `key` 变化 = 卸载 + 全新挂载，
> 新实例的入场走的正是上面测的这条路（`initial` → `animate` on mount）。浏览器里
> 打不开项目，`Sidebar` 的 `key` 恒为 `"empty"`、`AiPanel` 需要已配置模型，所以
> 只能这样论证——但论证是充分的。

## 仍未覆盖的一格

**没有在真 Tauri 窗口 + 系统「减弱动态效果」下亲眼跑过**（那要改作者本机的系统
设置）。上面的测量是在一个 `visibilityState === 'visible'` 的真实 Chrome 里、
`matchMedia('(prefers-reduced-motion: reduce)').matches === true` 的条件下做的，
覆盖了同一条代码路径；但 WKWebView 与 Chrome 不是同一个引擎，这一格留白如实记在
这里。要补的话：`pnpm tauri dev`，系统设置打开「减弱动态效果」，看侧栏内容是否
可见、切换「文件/大纲」标签后是否仍可见。

## 教训（比结论本身更值钱）

- **在预览面板/隐藏标签页里，「等一会儿再看」这个动作本身是错的。** 动画时间轴
  不走，`setTimeout` 被节流到约 1s，任何「t+150ms 采样」都在说谎。要验动画就用
  Web Animations API：`node.getAnimations()` 读名字/时长/曲线，再
  `a.currentTime = 0` / `a.finish()` 自己驱动，两端各读一次计算样式。
- **一次读数与代码自相矛盾时，先怀疑读数。** 这次的矛盾（`transform` 不该在那儿）
  一眼可见，却在 plans/README.md 里挂了三天，还连累方案 017 回退。
- 顺带：`animation`/`transition` 的「感觉」仍然没法这样验——只能说明接线对了。

## 后续

- 方案 017（`plans/017-onboarding-step-enter-only.md`）的 BLOCKED 由本文解除，
  状态改回 TODO，方案内容不用改。
- `plans/README.md`「阻断 B」一节指向本文。
