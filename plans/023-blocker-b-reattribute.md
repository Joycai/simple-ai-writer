# 023 — 阻断 B 重新归因：enter-only `motion.div` 在减动效下是否真的停在 initial

- **Status**: DONE (2026-08-26) — 第 1 步的测量已完成，结论是**分支 A：不是缺陷**。减动效下 `transform` 被 `useMotionPreset` 正确剥掉、`opacity` 收敛到 1。读数与方法见 `docs/issues/motion-enter-only-hidden-tab.md`；`Sidebar.tsx` / `AiPanel.tsx` 未做任何改动，方案 017 已解锁
- **Commit**: 93eb7de
- **Severity**: HIGH（若成立是无障碍缺陷；但**归因存疑**，见下）
- **Category**: 无障碍 / 可中断性
- **Estimated scope**: 第 1 步纯测量（不改代码）；改动量取决于测量结果

> **这份方案的第 1 步是复现与归因，不是修复。**
> 在第 1 步给出结论之前，**一行代码都不要改**。下面的 Target/Steps 分成两条互斥
> 分支，走哪条由第 1 步的测量决定。

## Problem

`plans/README.md` 的「阻断 B」记录（2026-08-23，基准 36eda7b）：开着系统的
Reduced Motion 跑起来，侧栏面板内容永久停在 `opacity: 0`——不是时序问题，等
1.2s 之后依旧是 0。结论是「方案 004 引入的 enter-only 模式（keyed `motion.div` +
`initial`/`animate`，无 `AnimatePresence`）在 `MotionConfig reducedMotion="user"`
下不会推进到 `animate`」，并因此把方案 017 回退、标记 BLOCKED。

到 93eb7de，这两处源码**原封未动**：

```tsx
// src/components/layout/Sidebar.tsx:86
  const contentVariants = useMotionPreset(panelFade);

// src/components/layout/Sidebar.tsx:124-131
      {/* Enter-only（照 AiPanel.tsx:1384 的注释与先例）：标签切换是直接操纵，
          新面板应立即落位；keyed motion.div 仍会重置子树。 */}
      <motion.div
        key={projectPath ? activeSideTab : "empty"}
        className={isTree ? styles.contentFlush : styles.content}
        variants={contentVariants}
        initial="initial"
        animate="animate"
        transition={springPanel}
      >
```

```tsx
// src/components/ai/AiPanel.tsx:1359 / 1437-1443 — 同一模式
  const sectionVariants = useMotionPreset(panelFade);
  …
              <motion.div
                key={selectedTask}
                className={styles.section}
                variants={sectionVariants}
                initial="initial"
                animate="animate"
                transition={springPanel}
              >
```

`docs/issues/` 里也没有对应记录。**但原报告的机理与代码自相矛盾，必须先解决这个
矛盾再动手。**

### 矛盾一：原报告测到的内联样式里 `transform` 还在

原记录写的是：

```
_contentFlush_1wdy8_102  →  computedOpacity "0"   239×672
                            inline: "opacity: 0; transform: translateY(6px);"
```

而 `useMotionPreset()` 在减动效下的**唯一职责**就是把 `transform` 从每个 variant
里剥掉：

```ts
// src/lib/motion.ts:41-54 — 现状
export function useMotionPreset(preset: Variants): Variants {
  const reduced = useReducedMotion();
  return useMemo(() => {
    if (!reduced) return preset;
    const out: Variants = {};
    for (const [name, def] of Object.entries(preset)) {
      if (typeof def === "function") { out[name] = def; continue; }
      const { transform: _transform, ...rest } = def;
      out[name] = rest;
    }
    return out;
  }, [reduced, preset]);
}
```

`panelFade.initial` 是 `{ opacity: 0, transform: "translateY(6px)" }`
（`src/lib/motion.ts:95-99`）。若 `useReducedMotion()` 当时返回 `true`，内联样式
里**不可能**还有 `transform: translateY(6px)`。即：那次测量里减动效这条路径
根本没生效，那么「reduced-motion 导致停在 initial」的归因就没有证据支撑。

### 矛盾二：那次测量很可能在一个被节流的隐藏标签页里做的

`plans/README.md` 那条记录写于 2026-08-23。此后（2026-08-25）在别处坐实了一件事：
**浏览器预览面板的标签页 `visibilityState === 'hidden'`，动画时间轴根本不推进**
——CSS 动画永远停在第 0 帧，`setTimeout` 被节流到约 1s，所以任何「等 t+150ms 再
采样」的探针都会说谎。

Motion 靠 rAF/WAAPI 驱动。**在一个隐藏标签页里，rAF 不派发，一个
`motion.div` 就会永久停在它的 `initial` 值上——`opacity: 0` 加
`transform: translateY(6px)`，一字不差就是原报告测到的那串内联样式。**
而同一棵树里被 `AnimatePresence` 包着的 `fillLayer` 收敛到了 `opacity: 1`，
也与此相容：那些元素在页面转入隐藏之前就已经完成了。

这个假设同时解释了矛盾一和「等 1.2s 依旧是 0」，而「reduced-motion 让 Motion 停在
initial」两条都解释不了。**所以最可能的结论是：阻断 B 是测量方法的产物，不是缺陷。**
但「最可能」不是「已确认」——README 里现在挂着一条 BLOCKED 的方案（017），
它的解锁只能靠一次做对的测量。

## Steps · 第 1 步（必做，且在做完之前不改任何代码）

用**在隐藏标签页里依然成立**的方法测量。要点：不看截图、不用 `setTimeout` 采样、
不读过渡中途的 `getComputedStyle`——这三样在预览面板里都会说谎。改用 Web
Animations API 直接问元素「你身上有没有动画、它的终态是什么」。

1. 起服务：`pnpm dev`（端口 1420）。用浏览器预览面板打开
   （`preview_start {name:"simple-ai-writer"}`，`.claude/launch.json` 已配好），
   或本机 Chrome 直连 `http://127.0.0.1:1420`。
   > 侧栏内容需要 `projectPath` 才会渲染出文件树；浏览器里打不开项目。这没关系
   > ——`motion.div` 本身**无论如何都会挂载**（`key` 会取 `"empty"` 分支），
   > 空态文案就在它里面。要测的是这个 `motion.div`，不是它的内容。
2. **先在不开减动效的情况下测一遍基线**，在页面控制台执行：

```js
const el = document.querySelector('[class*="content"]')   // Sidebar 的 motion.div
// 更稳的取法：先在 Elements 面板找到带 inline `opacity`/`transform` 的那个 div
const anims = el.getAnimations();
console.log({
  inline: el.getAttribute('style'),
  computedOpacity: getComputedStyle(el).opacity,
  animations: anims.map(a => ({
    playState: a.playState,
    currentTime: a.currentTime,
    duration: a.effect?.getComputedTiming()?.duration,
  })),
});
// 手动把动画推到终点——这是隐藏标签页里唯一可信的终态读法
anims.forEach(a => a.finish());
console.log('after finish →', getComputedStyle(el).opacity, el.getAttribute('style'));
```

3. **再开减动效重测**：Rendering 面板 → Emulate CSS media feature
   `prefers-reduced-motion: reduce`（或 CDP `Emulation.setEmulatedMedia`），
   **刷新页面**（`useReducedMotion` 要在挂载时就读到），切换侧栏「文件/大纲」
   标签让 `key` 变化，重跑第 2 步那段脚本。
4. 按结果分流。三种可能，对应三条不同的路：

| 观察到的 | 说明 | 走哪条分支 |
| --- | --- | --- |
| 减动效下 `el.getAttribute('style')` 里**没有** `transform`，且 `getAnimations()` 里有条目 / `finish()` 后 opacity 变 1 | `useMotionPreset` 生效、Motion 也在跑，只是隐藏标签页不推进时间 | **分支 A：不是缺陷** |
| 减动效下内联样式里**仍有** `transform: translateY(6px)` | `useReducedMotion()` 没返回 true——真问题在这里，与 enter-only 无关 | **分支 B-1** |
| `getAnimations()` **返回空**，且 `finish()` 后 opacity 仍是 0 | Motion 压根没创建动画——原报告的归因成立 | **分支 B-2** |
5. **最后必须在真窗口里复核一次**：`pnpm tauri dev`，系统设置里真的打开
   「减弱动态效果」，肉眼确认侧栏内容可见、切换标签后仍可见。Tauri 窗口不是隐藏
   标签页，这一步是对上面全部推理的终审。若真窗口里侧栏是可见的，无论浏览器里
   测出什么，**结论都是分支 A**。

## 分支 A —— 不是缺陷（预期最可能）

**不改任何组件代码。** 要做的是把这次测量固化下来，免得下一个人再被同一个陷阱
绊一次：

1. 新建 `docs/issues/motion-enter-only-hidden-tab.md`，状态标「已澄清（非缺陷）」，
   记：症状（enter-only `motion.div` 永久停在 `initial`）、真实成因
   （预览面板标签页 `visibilityState === 'hidden'`，rAF 不派发）、以及**正确的
   测量方法**（Web Animations API + `a.finish()`，不用截图、不用定时采样）。
   把本方案「矛盾一/矛盾二」两节的推理搬进去——它是这份结论的证据。
2. 改 `plans/README.md`：把「阻断 B」整节改写为已澄清，指向上面这份 issue。
3. 把方案 017（`plans/017-onboarding-step-enter-only.md`）的 Status 从
   `BLOCKED · 阻断 B` 改回 `TODO`，并在文件里加一行说明解除依据（指向新 issue）。
   **不要顺手执行 017**——它是独立一份方案，独立评审。

## 分支 B —— 真是缺陷

**B-1（`useReducedMotion()` 没生效）**：问题在 `src/lib/motion.ts` 这一侧，
与 enter-only 模式无关，`AnimatePresence` 包着的表面同样受影响。先查
`useReducedMotion` 的返回值与 `window.matchMedia("(prefers-reduced-motion: reduce)").matches`
是否一致，再决定是换成直接读 `matchMedia`（`appStore.ts:351` 已有先例）还是别的。
**这种情况下停下来先报告**，不要直接改——影响面比本方案大。

**B-2（Motion 没创建动画）**：给这两处 enter-only 表面兜底，让减动效下**终态
一定可见**。最小改动是让 `initial` 在减动效下就等于终态（而不是靠动画推进）：

```tsx
// src/components/layout/Sidebar.tsx — B-2 目标
  const reduced = useReducedMotion();          // from "motion/react"
  const contentVariants = useMotionPreset(panelFade);
  …
      <motion.div
        key={projectPath ? activeSideTab : "empty"}
        className={isTree ? styles.contentFlush : styles.content}
        variants={contentVariants}
        // 减动效下不入场：直接以终态挂载。enter-only 没有 AnimatePresence 兜底，
        // 一旦动画没推进，元素就永久停在 initial —— 那是不可见，不是「少一点动效」。
        initial={reduced ? "animate" : "initial"}
        animate="animate"
        transition={springPanel}
      >
```

`src/components/ai/AiPanel.tsx:1437` 同样处理。**两处都要改**，且改完必须重跑
第 1 步的测量确认 opacity 收敛到 1。

## Repo conventions to follow

- `useReducedMotion` 从 `"motion/react"` 导入（`src/lib/motion.ts:3` 已经这么用）。
- enter-only（keyed `motion.div`，无 `AnimatePresence`）是**刻意的既定模式**，
  理由写在 `src/components/ai/AiPanel.tsx:1428-1436` 和方案 004 里：标签/任务切换是
  直接操纵，`mode="wait"` 的交叉淡出会把新面板压后一个出场时长。
  **无论走哪条分支，都不要把它改成 `AnimatePresence`**——那是方案 004 明确否决过的。
- `docs/` 分组按**类型**，状态是文档里的一个字段而不是文件夹（见 `docs/README.md`）；
  新 issue 落 `docs/issues/`，并在 `docs/README.md` 的索引表里加一行。

## Boundaries

- **第 1 步完成前不改任何代码。**
- 不改 `src/lib/motion.ts` 的 `useMotionPreset`（除非走 B-1，而 B-1 要求先停下报告）。
- 不改 `App.tsx:106` 的 `<MotionConfig reducedMotion="user">`——design-system.md:251
  明写「keep it there」。
- 不动 `App.tsx` / `SettingsPage.tsx` / `LoreWall.tsx` / `AiDrawer.tsx` 里那些被
  `AnimatePresence` 包着的 `motion` 元素——它们不属于本方案讨论的模式。
- 不执行方案 017（即使分支 A 把它解锁了）。
- 不因为「顺手」就把 `panelFade` 的位移值调小——那不解决任何一个分支的问题。

## Verification

- **第 1 步的测量本身就是验证。** 记录必须落纸：三组读数（基线 / 减动效 /
  真窗口）原样抄进新 issue 或方案 README，**不要只写结论**。
- 若走分支 B：
  - `pnpm tsc --noEmit`、`pnpm build` 通过。
  - 重跑第 1 步的脚本，减动效下 `getComputedStyle(el).opacity` 必须是 `"1"`。
  - `pnpm tauri dev` + 系统「减弱动态效果」打开：侧栏内容可见；切换「文件/大纲」
    标签后仍可见；AI 面板切换任务后配置区仍可见。
  - **关掉**减动效再走一遍：入场动画必须**还在**（不能为了修可见性把动效删掉——
    reduced motion 是「更少更柔」，不是把所有人都降级）。
- **Done when**：三组读数记录在案；README 的阻断 B 与方案 017 的状态都更新到位；
  若改了代码，减动效开/关两种情况都亲眼确认过。
